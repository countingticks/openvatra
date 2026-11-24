/** The layers a fake model holds, for core's completeness rule. */
export interface GgufLayers {
  blockCount: number
  nextn?: number // <arch>.nextn_predict_layers; omitted = key not written
  blocks: number[] // one tensor blk.N.attn_norm.weight per entry, offsets 0, 32, 64, …
}

/**
 * The smallest valid GGUF file: magic, version 3 and the key `general.architecture`. core reads the header to
 * classify a model, so a fake model must have one ("llama" reads as a chat model). Without layers it has no tensors
 * and that one key; with layers it also states block_count (and nextn_predict_layers) and holds one tensor per block.
 */
export function ggufHeader(architecture: string, layers?: GgufLayers): Buffer {
  const text = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(bytes.length))
    return Buffer.concat([length, bytes])
  }
  const u32 = (value: number): Buffer => {
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32LE(value)
    return bytes
  }
  const u64 = (value: number): Buffer => {
    const bytes = Buffer.alloc(8)
    bytes.writeBigUInt64LE(BigInt(value))
    return bytes
  }
  const typeUint32 = 4
  const typeString = 8

  const pairs = [Buffer.concat([text('general.architecture'), u32(typeString), text(architecture)])]
  const tensors: Buffer[] = []
  if (layers) {
    pairs.push(Buffer.concat([text(`${architecture}.block_count`), u32(typeUint32), u32(layers.blockCount)]))
    if (layers.nextn !== undefined) {
      pairs.push(
        Buffer.concat([text(`${architecture}.nextn_predict_layers`), u32(typeUint32), u32(layers.nextn)])
      )
    }
    layers.blocks.forEach((block, i) => {
      // One dimension of 1, type 0 (F32), then the offset.
      tensors.push(
        Buffer.concat([text(`blk.${block}.attn_norm.weight`), u32(1), u64(1), u32(0), u64(32 * i)])
      )
    })
  }
  const head = Buffer.alloc(24)
  head.write('GGUF', 0, 'ascii')
  head.writeUInt32LE(3, 4) // version
  head.writeBigUInt64LE(BigInt(tensors.length), 8)
  head.writeBigUInt64LE(BigInt(pairs.length), 16)
  return Buffer.concat([head, ...pairs, ...tensors])
}
