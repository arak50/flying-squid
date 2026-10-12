// Raw packet building. The sniffed slot bytes are spliced into packets WITHOUT re-encoding them.
function varint (n) {
  const out = []
  n = n >>> 0
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b) } while (n)
  return Buffer.from(out)
}

// name -> numeric id for the clientbound play packets, straight from the protocol data of the running version
function clientboundIds (registry) {
  const m = registry.protocol.play.toClient.types.packet[1][0].type[1].mappings
  const ids = {}
  for (const [hex, name] of Object.entries(m)) ids[name] = parseInt(hex, 16)
  return ids
}

const EMPTY_SLOT = Buffer.from([0])

module.exports = { varint, clientboundIds, EMPTY_SLOT }
