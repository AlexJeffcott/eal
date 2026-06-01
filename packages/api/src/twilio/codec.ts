/**
 * Phase 7B audio codec — bridges Twilio Media Streams (G.711 μ-law, 8 kHz)
 * and the family-phone relay (linear 16-bit signed PCM, 24 kHz, mono).
 *
 * All functions are pure: input bytes/samples in, transformed buffer out.
 * No network, no allocation outside the returned buffer. Twilio's stream
 * format is documented at
 * https://www.twilio.com/docs/voice/twiml/stream#message-media — every
 * `media` event carries one 20 ms PCMU frame as base64.
 */

/**
 * Decode a single G.711 μ-law byte to a linear 16-bit signed PCM sample,
 * per ITU-T G.711 §2.5. The reference table is small; computing it by
 * hand at startup is the same speed as a hard-coded table and makes the
 * formula auditable.
 */
function muLawByteToPcm(u: number): number {
  // Inverted bit pattern on the wire.
  const inverted = ~u & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  // The bias of 33 reverses the encoder's pre-add. Magnitude is in the
  // upper 14 bits of a 16-bit signed sample; the leading -33 trims the
  // encoder bias back off.
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  return sign === 0 ? magnitude : -magnitude;
}

/**
 * Encode a linear 16-bit signed PCM sample to a G.711 μ-law byte.
 * Inverse of `muLawByteToPcm`; same ITU-T tables.
 */
function pcmSampleToMuLaw(sample: number): number {
  const clipped = sample < -32_635 ? -32_635 : sample > 32_635 ? 32_635 : sample;
  const sign = clipped < 0 ? 0x80 : 0;
  const magnitude = (clipped < 0 ? -clipped : clipped) + 0x84;
  // exponent = floor(log2(magnitude)) - 7, clamped to [0, 7].
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  const byte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return byte;
}

/** Decode an N-byte PCMU buffer into an N-sample Int16 PCM buffer. */
export function pcmuToPcm16(pcmu: Uint8Array): Int16Array {
  const out = new Int16Array(pcmu.length);
  for (let i = 0; i < pcmu.length; i++) {
    const byte = pcmu[i];
    if (byte === undefined) continue;
    out[i] = muLawByteToPcm(byte);
  }
  return out;
}

/** Encode an Int16 PCM buffer into an N-byte PCMU buffer (same length). */
export function pcm16ToPcmu(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm[i];
    if (sample === undefined) continue;
    out[i] = pcmSampleToMuLaw(sample);
  }
  return out;
}

/**
 * Linear-interpolate-upsample 8 kHz PCM to 24 kHz PCM. Each input sample
 * yields three output samples: the original, and two interpolated points
 * 1/3 and 2/3 between it and the next sample. The final sample is
 * triplicated since there is no next sample to interpolate against.
 *
 * Good enough for speech relay; if quality is poor in production, swap
 * for a windowed-sinc resampler. The tests pin the byte counts so a
 * future swap can't silently shift the rate ratio.
 */
export function upsample8To24(pcm: Int16Array): Int16Array {
  const out = new Int16Array(pcm.length * 3);
  for (let i = 0; i < pcm.length; i++) {
    const a = pcm[i] ?? 0;
    const b = i + 1 < pcm.length ? (pcm[i + 1] ?? 0) : a;
    out[i * 3] = a;
    out[i * 3 + 1] = Math.round(a + (b - a) / 3);
    out[i * 3 + 2] = Math.round(a + (2 * (b - a)) / 3);
  }
  return out;
}

/**
 * Boxcar-average-downsample 24 kHz PCM to 8 kHz PCM. Every three input
 * samples become one output sample (their mean). Trailing inputs that
 * do not complete a triple are averaged with the available samples.
 *
 * This is a 3-tap moving average — a crude low-pass with a roll-off
 * around 4 kHz. Speech intelligibility is fine; a proper anti-alias
 * filter is a follow-up if the wire signal sounds harsh.
 */
export function downsample24To8(pcm: Int16Array): Int16Array {
  const outLen = Math.ceil(pcm.length / 3);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < 3; j++) {
      const sample = pcm[i * 3 + j];
      if (sample === undefined) break;
      sum += sample;
      count += 1;
    }
    if (count > 0) out[i] = Math.round(sum / count);
  }
  return out;
}

/**
 * Twilio → relay: decode one PCMU frame and resample to the 24 kHz PCM
 * the family-phone relay forwards between devices.
 */
export function pcmuFrameToRelayPcm(pcmu: Uint8Array): Int16Array {
  return upsample8To24(pcmuToPcm16(pcmu));
}

/**
 * Relay → Twilio: downsample the relay's 24 kHz PCM to 8 kHz and encode
 * as PCMU. The output buffer is the shape Twilio's media WS expects.
 */
export function relayPcmToPcmuFrame(pcm: Int16Array): Uint8Array {
  return pcm16ToPcmu(downsample24To8(pcm));
}
