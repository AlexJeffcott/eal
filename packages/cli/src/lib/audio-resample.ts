/**
 * Linear-interpolation resampler for 16-bit PCM. Good enough for
 * speech: piper's 22050 → 24000 ratio is 1.088, and the artefacts of
 * linear interpolation at that ratio are inaudible. If the source rate
 * matches the target, the input is returned untouched.
 */
export function resampleInt16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const out = new Int16Array(outLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * step;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const a = input[srcIndex] ?? 0;
    const b = input[srcIndex + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/**
 * Split a sample buffer into fixed-size frames, yielding each as a
 * fresh Int16Array. The final partial frame is zero-padded so every
 * yielded frame has exactly `samplesPerFrame` samples — the call wire
 * expects all frames the same size.
 */
export function* chunkInt16(samples: Int16Array, samplesPerFrame: number): Iterable<Int16Array> {
  if (samplesPerFrame <= 0) return;
  for (let i = 0; i < samples.length; i += samplesPerFrame) {
    const remaining = samples.length - i;
    if (remaining >= samplesPerFrame) {
      yield samples.subarray(i, i + samplesPerFrame);
    } else {
      const padded = new Int16Array(samplesPerFrame);
      padded.set(samples.subarray(i));
      yield padded;
    }
  }
}
