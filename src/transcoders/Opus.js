// Partly based on https://github.com/Rantanen/node-opus/blob/master/lib/Encoder.js

const { Transform } = require('stream');
const loader = require('../util/loader');

const CTL = {
  BITRATE: 4002,
  FEC: 4012,
  PLP: 4014,
};

const Opus = loader.require([
  ['krypton', o => {
    if (!o.opus.version) throw Error('Krypton found, but Opus is not available');
    return o.opus.OpusEncoder;
  }],
  ['node-opus', o => o.OpusEncoder],
  ['opusscript', o => o],
], {
  fn: 'Encoder',
});

const charCode = x => x.charCodeAt(0);
const OPUS_HEAD = Buffer.from([...'OpusHead'].map(charCode));
const OPUS_TAGS = Buffer.from([...'OpusTags'].map(charCode));

// frame size = (channels * rate * frame_duration) / 1000

/**
 * Takes a stream of Opus data and outputs a stream of PCM data, or the inverse.
 */
class OpusStream extends Transform {
  /**
   * Creates a new Opus transformer.
   * @param {Object} [options] options that you would pass to a regular Transform stream, plus more:
   * @param {boolean} [options.parallel=true] If true and Krypton is installed, multiple threads will be used.
   */
  constructor(options = { parallel: true }) {
    if (!Opus.Encoder) {
      throw Error('Could not find an Opus module! Please install node-opus or opusscript.');
    }
    super(Object.assign({ readableObjectMode: true }, options));
    if (Opus.name === 'opusscript') {
      options.application = Opus.Encoder.Application[options.application];
    }
    this.encoder = new Opus.Encoder(options.rate, options.channels, options.application);
    if (Opus.name === 'krypton') {
      if (options.parallel) {
        Opus.module.count++;
        this.once('end', () => Opus.module.count--);
      }
      this._encode = buffer => Opus.module.do(this.encoder.encode(buffer)).run(options.parallel ? undefined : false);
      this._decode = buffer => Opus.module.do(this.encoder.decode(buffer)).run(options.parallel ? undefined : false);
    }
    this._options = options;
    this._required = this._options.frameSize * this._options.channels * 2;
  }

  _encode(buffer) {
    return this.encoder.encode(buffer, Opus.name !== 'node-opus' ? this._options.frameSize : null);
  }

  _decode(buffer) {
    return this.encoder.decode(buffer, Opus.name !== 'node-opus' ? this._options.frameSize : null);
  }

  /**
   * Returns the Opus module being used - `krypton`, `opusscript` or `node-opus`.
   * @type {string}
   */
  static get type() {
    return Opus.name;
  }

  /**
   * Sets the bitrate of the stream.
   * @param {number} bitrate the bitrate to use use, e.g. 48000
   */
  setBitrate(bitrate) {
    (this.encoder.applyEncoderCTL || this.encoder.encoderCTL)
      .apply(this.encoder, [CTL.BITRATE, Math.min(128e3, Math.max(16e3, bitrate))]);
  }

  /**
   * Enables or disables forward error correction.
   * @param {boolean} enabled whether or not to enable FEC.
   */
  setFEC(enabled) {
    (this.encoder.applyEncoderCTL || this.encoder.encoderCTL)
      .apply(this.encoder, [CTL.FEC, enabled ? 1 : 0]);
  }

  /**
   * Sets the expected packet loss over network transmission.
   * @param {number} [percentage] a percentage (represented between 0 and 1)
   */
  setPLP(percentage) {
    (this.encoder.applyEncoderCTL || this.encoder.encoderCTL)
      .apply(this.encoder, [CTL.FEC, Math.min(100, Math.max(0, percentage * 100))]);
  }

  _final(cb) {
    if (Opus.name === 'opusscript' && this.encoder) this.encoder.delete();
    cb();
  }
}

/**
 * Represents an Opus encoder stream.
 * @extends {OpusStream}
 * @inheritdoc
 */
class Encoder extends OpusStream {
  /**
   * Creates a new Opus encoder stream.
   * @param {Object} options options that you would pass to a regular OpusStream, plus a few more:
   * @param {number} options.frameSize the frame size to use (e.g. 960 for stereo audio at 48KHz with a frame
   * duration of 20ms)
   * @param {number} options.channels the number of channels to use
   */
  constructor(options) {
    super(options);
    this._buffer = Buffer.alloc(0);
  }

  async _transform(chunk, encoding, done) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    let n = 0;
    while (this._buffer.length >= this._required * (n + 1)) {
      const buf = await this._encode(this._buffer.slice(n * this._required, (n + 1) * this._required));
      this.push(buf);
      n++;
    }
    if (n > 0) this._buffer = this._buffer.slice(n * this._required);
    return done();
  }

  _destroy(err, cb) {
    super._destroy(err, cb);
    this._buffer = null;
  }
}

/**
 * Represents an Opus decoder stream.
 * @extends {OpusStream}
 */
class Decoder extends OpusStream {
  _transform(chunk, encoding, done) {
    const signature = chunk.slice(0, 8);
    if (signature.equals(OPUS_HEAD)) {
      this.emit('format', {
        channels: this._options.channels,
        sampleRate: this._options.rate,
        bitDepth: 16,
        float: false,
        signed: true,
        version: chunk.readUInt8(8),
        preSkip: chunk.readUInt16LE(10),
        gain: chunk.readUInt16LE(16),
      });
      return done();
    }
    if (signature.equals(OPUS_TAGS)) {
      this.emit('tags', chunk);
      return done();
    }
    this.push(this._decode(chunk));
    return done();
  }
}

module.exports = { Decoder, Encoder };
