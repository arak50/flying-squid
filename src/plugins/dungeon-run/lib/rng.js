'use strict'
/**
 * Seeded randomness for a dungeon run.
 *
 * One run seed, many independent streams: every concern (key placement, one room's mobs, the Watcher ...) derives its own
 * generator from `derive(seed, ...labels)`. A stream never depends on how many numbers another stream consumed, so the
 * outcome of room 4 is the same whether it is entered first or last, and adding a new random feature cannot shift old ones.
 */

function hashString (s) { // cyrb-style 32 bit string hash
  s = String(s)
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19 }
  h = Math.imul(h ^ h >>> 16, 2246822507)
  h = Math.imul(h ^ h >>> 13, 3266489909)
  return (h ^ h >>> 16) | 0
}

function mulberry32 (a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

class Rng {
  constructor (seed) { this.seed = seed | 0; this._next = mulberry32(this.seed) }
  next () { return this._next() } // [0, 1)
  int (n) { return Math.floor(this.next() * n) } // [0, n)
  range (lo, hi) { return lo + this.int(hi - lo + 1) } // [lo, hi] inclusive
  chance (p) { return this.next() < p }
  pick (arr) { return arr[this.int(arr.length)] }
  shuffle (arr) { // in place
    for (let i = arr.length - 1; i > 0; i--) { const j = this.int(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]] }
    return arr
  }
}

/** Independent stream for (seed, label...). */
const derive = (seed, ...labels) => new Rng(hashString(`${seed | 0}|${labels.join('|')}`))

module.exports = { Rng, derive, hashString, mulberry32 }
