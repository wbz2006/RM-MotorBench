/* Small browser implementation of the Buffer methods used by protocol.js. */
if (!globalThis.Buffer) {
  class BrowserBuffer extends Uint8Array {
    static alloc(size) { return new BrowserBuffer(size); }

    static from(value, encoding) {
      if (typeof value === 'string' && encoding === 'base64') {
        const binary = atob(value);
        return new BrowserBuffer(Array.from(binary, char => char.charCodeAt(0)));
      }
      if (typeof value === 'number') throw new TypeError('Buffer.from does not accept a number');
      return new BrowserBuffer(value);
    }

    static concat(parts) {
      const result = new BrowserBuffer(parts.reduce((length, part) => length + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
      }
      return result;
    }

    view(offset, bytes) {
      return new DataView(this.buffer, this.byteOffset + offset, bytes);
    }

    writeUInt8(value, offset) { this.view(offset, 1).setUint8(0, value); }
    writeUInt16LE(value, offset) { this.view(offset, 2).setUint16(0, value, true); }
    writeInt8(value, offset) { this.view(offset, 1).setInt8(0, value); }
    writeInt32LE(value, offset) { this.view(offset, 4).setInt32(0, value, true); }
    writeFloatLE(value, offset) { this.view(offset, 4).setFloat32(0, value, true); }
    readUInt16LE(offset) { return this.view(offset, 2).getUint16(0, true); }
    readInt8(offset) { return this.view(offset, 1).getInt8(0); }
    readInt32LE(offset) { return this.view(offset, 4).getInt32(0, true); }
    readFloatLE(offset) { return this.view(offset, 4).getFloat32(0, true); }

    toString(encoding = 'utf8') {
      if (encoding === 'hex') return Array.from(this, byte => byte.toString(16).padStart(2, '0')).join('');
      return new TextDecoder().decode(this);
    }
  }

  globalThis.Buffer = BrowserBuffer;
}
