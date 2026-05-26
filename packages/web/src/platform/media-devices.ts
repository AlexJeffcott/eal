/**
 * Adapter over the browser's MediaDevices interface (microphone, camera).
 *
 * Production code imports `mediaDevices` instead of reaching for
 * `navigator.mediaDevices` directly. Tests swap the export via
 * `mock.module('.../media-devices.ts', () => ({ mediaDevices: stub }))`
 * and assert getUserMedia was invoked with the right constraints
 * without ever touching a real microphone.
 */
const candidate =
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices !== 'undefined'
    ? navigator.mediaDevices
    : null;
export const mediaDevices: MediaDevices | null = candidate;
