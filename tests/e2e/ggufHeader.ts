/**
 * The smallest valid GGUF file: magic, version 3, no tensors and one key, `general.architecture`. core reads the
 * header to classify a model, so a fake model must have one ("llama" reads as a chat model).
 */
export function ggufHeader(architecture: string): Buffer {
  const text = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(bytes.length))
    return Buffer.concat([length, bytes])
  }
  const head = Buffer.alloc(24)
  head.write('GGUF', 0, 'ascii')
  head.writeUInt32LE(3, 4) // version
  head.writeBigUInt64LE(0n, 8) // tensors
  head.writeBigUInt64LE(1n, 16) // key/value pairs
  const type = Buffer.alloc(4)
  type.writeUInt32LE(8) // string
  return Buffer.concat([head, text('general.architecture'), type, text(architecture)])
}
