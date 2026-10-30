import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  MapPin,
  Mic,
  MoreHorizontal,
  Plus,
  Sparkles,
  Square,
} from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Field,
  IconButton,
  Progress,
  Select,
  Switch,
  useToast,
} from './ui';
import s from '../pages/pages.module.css';

export function ButtonExamples() {
  const notify = useToast();
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  function load() {
    setLoading(true);
    timer.current = setTimeout(() => {
      setLoading(false);
      notify({ title: 'All set.', description: 'That’s the loading button in action.' });
    }, 1600);
  }
  return (
    <div className={s.buttonExamples}>
      <div className={s.buttonRow}>
        <Button
          icon={<Plus size={15} />}
          onClick={() =>
            notify({
              title: 'A clear next step.',
              description: 'Primary actions use Satvey olive.',
            })
          }
        >
          New inspection
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            notify({
              title: 'Secondary action selected',
              description: 'A quieter option alongside a primary action.',
            })
          }
        >
          View details
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            notify({
              title: 'A subtle action.',
              description: 'Ghost buttons keep supporting actions in reach.',
            })
          }
        >
          Learn more
          <ArrowRight size={14} />
        </Button>
      </div>
      <div className={s.buttonRow}>
        <Button
          size="sm"
          variant="secondary"
          icon={<Check size={14} />}
          onClick={() => notify({ title: 'Small button selected' })}
        >
          Approve
        </Button>
        <Button size="sm" loading={loading} onClick={load}>
          {loading ? 'Saving…' : 'Try loading'}
        </Button>
        <Button size="sm" disabled>
          Disabled
        </Button>
        <IconButton
          label="More button options"
          variant="secondary"
          onClick={() =>
            notify({
              title: 'Icon button selected',
              description: 'Icon-only actions always have an accessible label.',
            })
          }
        >
          <MoreHorizontal size={17} />
        </IconButton>
      </div>
    </div>
  );
}

export function FormExamples() {
  const [room, setRoom] = useState('Living room');
  const [checked, setChecked] = useState(true);
  const [enabled, setEnabled] = useState(true);
  return (
    <div className={s.formExamples}>
      <div className={s.twoColumns}>
        <Field label="Property name" placeholder="e.g. Willow House" defaultValue="Willow House" />
        <Select
          label="Room"
          items={['Living room', 'Kitchen', 'Bedroom', 'Bathroom']}
          value={room}
          onValueChange={setRoom}
        />
      </div>
      <div className={s.controlRow}>
        <Checkbox label="Include in report" checked={checked} onCheckedChange={setChecked} />
        <Switch label="AI assistance" checked={enabled} onCheckedChange={setEnabled} />
      </div>
    </div>
  );
}

export function StatusExamples() {
  return (
    <div className={s.statusExamples}>
      <Badge tone="success" dot>
        Approved
      </Badge>
      <Badge tone="warning" dot>
        Needs review
      </Badge>
      <Badge tone="ai" icon>
        AI suggested
      </Badge>
      <Badge tone="danger" dot>
        Critical
      </Badge>
      <Badge tone="info" dot>
        In progress
      </Badge>
      <Badge dot>Draft</Badge>
    </div>
  );
}

export function PropertyCard({ compact = false }: { compact?: boolean }) {
  return (
    <div className={s.propertyCard}>
      <div className={s.propertyImage}>
        <img
          src="/images/property-exterior.jpg"
          alt="A contemporary timber and white home framed by mature trees"
          width="1000"
          height="667"
          loading="lazy"
        />
        <span className={s.imageBadge}>
          <Badge tone="info" dot>
            In progress
          </Badge>
        </span>
      </div>
      <div className={s.propertyBody}>
        <div className={s.propertyHeading}>
          <div>
            <h3>Willow House</h3>
            <p>
              <MapPin size={12} />
              24 Willow Lane, Amsterdam
            </p>
          </div>
          <Avatar />
        </div>
        <div className={s.propertyMeta}>
          <span>Residential inspection</span>
          <span>12 Jun 2026</span>
        </div>
        <div className={s.progressLabel}>
          <span>Inspection progress</span>
          <strong>68%</strong>
        </div>
        <Progress value={68} />
        {!compact && (
          <div className={s.propertyFooter}>
            <span>8 of 12 rooms complete</span>
            <Badge tone="warning">3 to review</Badge>
          </div>
        )}
      </div>
    </div>
  );
}

const waveform = [
  9, 18, 12, 25, 16, 34, 23, 14, 28, 40, 23, 17, 31, 20, 42, 27, 16, 34, 24, 12, 29, 19, 38, 24, 14,
  32, 21, 10, 26, 17, 35, 23, 12, 29, 18, 37, 23, 14, 30, 20,
];
export function Waveform({ active = false }: { active?: boolean }) {
  return (
    <div className={`${s.waveform} ${active ? s.waveActive : ''}`} aria-hidden="true">
      {waveform.map((height, index) => (
        <span key={index} style={{ height, animationDelay: `${index * 37}ms` }} />
      ))}
    </div>
  );
}

export function DictationExample() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [text, setText] = useState('');
  const sample =
    'The living room is in good overall condition. Minor scuff marks are visible on the wall near the entrance. Recommend a touch-up during routine maintenance.';
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (!recording) return;
    let index = 0;
    const timer = setInterval(() => {
      index += 3;
      setText(sample.slice(0, index));
      if (index >= sample.length) {
        clearInterval(timer);
        setRecording(false);
      }
    }, 90);
    return () => clearInterval(timer);
  }, [recording]);
  return (
    <div className={s.dictationExample}>
      <div className={s.dictationTop}>
        <span>
          <span className={recording ? s.recordingDot : s.readyDot} />
          {recording ? 'Demo dictation in progress' : 'Dictation preview'}
        </span>
        <Badge>SIMULATED</Badge>
      </div>
      <div className={s.recordingRow}>
        <Button
          variant={recording ? 'destructive' : 'primary'}
          icon={recording ? <Square size={14} fill="currentColor" /> : <Mic size={16} />}
          onClick={() => {
            if (!recording) {
              setSeconds(0);
              setText('');
            }
            setRecording((v) => !v);
          }}
        >
          {recording ? 'Stop demo' : text ? 'Replay demo' : 'Start demo'}
        </Button>
        <Waveform active={recording} />
        <span className={s.recordingTime}>00:{String(seconds).padStart(2, '0')}</span>
      </div>
      <label htmlFor="demo-transcript" className={s.transcriptLabel}>
        Transcript <span>Editable sample text</span>
      </label>
      <textarea
        id="demo-transcript"
        className={s.textarea}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Start the demo to see an example transcript appear…"
        rows={4}
      />
      <p className={s.smallNote}>
        <Sparkles size={13} />A UI preview. Your microphone is never accessed.
      </p>
    </div>
  );
}
