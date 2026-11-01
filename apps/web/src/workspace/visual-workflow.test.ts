import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { activityInterval } from './activity';
import { organisationTheme } from './theme';
import { RoomAudio } from './roomAudio';
import { commitCaptureDraft, draftGet, draftPut } from './outbox';

vi.mock('./outbox', () => ({
  commitCaptureDraft: vi.fn().mockResolvedValue(undefined),
  draftGet: vi.fn().mockResolvedValue(undefined),
  draftPut: vi.fn().mockResolvedValue(undefined),
  draftRemove: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  cacheGet: vi.fn(),
  cachePut: vi.fn(),
  cacheKeys: vi.fn(),
  cacheRemove: vi.fn(),
}));

class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  constructor() {
    Recorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['recorded-audio']) });
    this.onstop?.();
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  Recorder.instances = [];
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({
        getAudioTracks: () => [{ readyState: 'live' }],
        getTracks: () => [{ stop: vi.fn() }],
      }),
    },
  });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => vi.unstubAllGlobals());
const audio = () =>
  new RoomAudio({
    scope: 'user:org',
    inspectionId: 'visit',
    path: '/orgs/org/inspections/visit',
    state: vi.fn(),
    error: vi.fn(),
  });

describe('automatic room audio', () => {
  it('does not start two recorders when camera readiness and recovery both start audio', async () => {
    const session = audio();
    await Promise.all([session.start('room-a'), session.start('room-a')]);
    expect(Recorder.instances).toHaveLength(1);
    await session.pause();
  });
  it('binds saved segments to the original room and preserves mute through room changes', async () => {
    const session = audio();
    await session.start('room-a');
    await session.setRoom('room-b');
    expect(vi.mocked(commitCaptureDraft).mock.calls[0][1].payload.roomId).toBe('room-a');
    await session.setMuted(true);
    expect(vi.mocked(commitCaptureDraft).mock.calls[1][1].payload.roomId).toBe('room-b');
    const count = Recorder.instances.length;
    await session.setRoom('room-c');
    expect(Recorder.instances).toHaveLength(count);
    await session.setMuted(false);
    await session.pause();
    expect(vi.mocked(commitCaptureDraft).mock.calls[2][1].payload.roomId).toBe('room-c');
    expect(vi.mocked(commitCaptureDraft).mock.calls[0][1].files?.[0].audioSegmentId).not.toBe(
      vi.mocked(commitCaptureDraft).mock.calls[1][1].files?.[0].audioSegmentId,
    );
  });
  it('recovers durable audio chunks into an independently queued room recording', async () => {
    vi.mocked(draftGet).mockResolvedValueOnce({
      draft: true,
      id: 'recovered',
      roomId: 'room-old',
      segmentId: 'segment-old',
      mime: 'audio/webm',
      startedAt: 1000,
      lastAt: 3000,
      chunks: [new TextEncoder().encode('old audio').buffer],
    });
    await audio().recover();
    const saved = vi.mocked(commitCaptureDraft).mock.calls[0][1];
    expect(saved.id).toBe('recovered');
    expect(saved.payload.roomId).toBe('room-old');
    expect(saved.files?.[0].duration).toBe(2);
  });
  it('does not advance rooms after durable audio storage fails', async () => {
    const session = audio();
    await session.start('room-a');
    vi.mocked(draftPut).mockRejectedValueOnce(new Error('Storage full'));
    await expect(session.setRoom('room-b')).rejects.toThrow('Storage full');
    expect(Recorder.instances).toHaveLength(1);
    expect(commitCaptureDraft).not.toHaveBeenCalled();
  });
});
describe('automatic active time', () => {
  it('stops review time at the inactivity cutoff without inventing the remaining gap', () => {
    expect(activityInterval(115000, 130000, 0, false)).toEqual({ start: 115000, finish: 120000 });
    expect(activityInterval(130000, 145000, 0, false)).toBeNull();
  });
  it('counts a quiet foreground walkthrough and bounds delayed heartbeat intervals', () => {
    expect(activityInterval(130000, 145000, 0, true)).toEqual({ start: 130000, finish: 145000 });
    expect(activityInterval(0, 300000, 0, true)).toEqual({ start: 270000, finish: 300000 });
  });
});
it('derives readable organisation tokens even from a pale tint and ignores invalid input', () => {
  expect(organisationTheme('invalid')).toEqual({});
  const tokens = organisationTheme('#ffffff') as Record<string, string>;
  expect(tokens['--primary']).not.toBe('#ffffff');
  expect(tokens['--primary-soft']).toBe('#ffffff');
  expect(tokens['--primary-hover']).toMatch(/^#[a-f\d]{6}$/);
});
