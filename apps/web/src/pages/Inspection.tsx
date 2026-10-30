import { useState } from 'react';
import { Tabs } from 'radix-ui';
import {
  Check,
  CircleCheck,
  ClipboardCheck,
  FileText,
  House,
  Pencil,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { Alert, Avatar, Badge, BrandMark, Button, Dialog, Field, cx } from '../components/ui';
import { DictationExample, PropertyCard } from '../components/examples';
import { PageHeader } from '../components/PageHeader';
import s from './pages.module.css';

function FindingPreview() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'dismissed'>('pending');
  const [editOpen, setEditOpen] = useState(false);
  const [title, setTitle] = useState('Minor surface wear');
  const [draft, setDraft] = useState(title);
  return (
    <div className={s.findingCard}>
      <div className={s.findingHeader}>
        <Badge tone="ai" icon>
          AI suggested · Sample
        </Badge>
        <Badge
          tone={status === 'approved' ? 'success' : status === 'dismissed' ? 'neutral' : 'warning'}
          dot
        >
          {status === 'approved'
            ? 'Inspector approved'
            : status === 'dismissed'
              ? 'Dismissed'
              : 'Needs review'}
        </Badge>
      </div>
      <h3>{title}</h3>
      <p>
        Minor scuff marks are visible on the wall near the living room entrance. The finish appears
        intact, with no indication of underlying damage in this sample observation.
      </p>
      <div className={s.findingDetails}>
        <div>
          <small>Location</small>
          <strong>Living room</strong>
        </div>
        <div>
          <small>Severity</small>
          <Badge tone="warning">Low · Cosmetic</Badge>
        </div>
        <div>
          <small>Suggested action</small>
          <strong>Routine touch-up</strong>
        </div>
      </div>
      <div className={s.findingReviewNote}>
        <Sparkles size={14} />
        AI suggests. The inspector decides.
      </div>
      {status === 'pending' ? (
        <div className={s.reviewActions}>
          <Button icon={<Check size={15} />} onClick={() => setStatus('approved')}>
            Approve sample
          </Button>
          <Dialog
            fullOnMobile
            open={editOpen}
            onOpenChange={(value) => {
              setEditOpen(value);
              if (value) setDraft(title);
            }}
            title="Add your perspective."
            description="Edit the sample finding title. Changes stay in this preview."
            trigger={
              <Button variant="secondary" icon={<Pencil size={14} />}>
                Edit
              </Button>
            }
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.trim()) {
                  setTitle(draft.trim());
                  setEditOpen(false);
                }
              }}
            >
              <Field
                label="Finding title"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                required
                maxLength={120}
              />
              <div className={s.dialogActions}>
                <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!draft.trim()}>
                  Save sample
                </Button>
              </div>
            </form>
          </Dialog>
          <Button variant="ghost" icon={<X size={14} />} onClick={() => setStatus('dismissed')}>
            Dismiss
          </Button>
        </div>
      ) : (
        <div className={s.reviewActions}>
          <Button
            variant="secondary"
            icon={<RotateCcw size={14} />}
            onClick={() => {
              setStatus('pending');
              setTitle('Minor surface wear');
            }}
          >
            Reset preview
          </Button>
        </div>
      )}
    </div>
  );
}

function RoomChecklist() {
  return (
    <div className={s.panel}>
      <h3 className={s.subheading}>A room-by-room view</h3>
      <p className={s.muted}>Ground floor · Sample checklist</p>
      <div className={s.roomList}>
        {[
          { name: 'Entrance & hallway', done: true, note: 'Complete' },
          { name: 'Living room', done: false, note: '1 to review' },
          { name: 'Kitchen', done: true, note: 'Complete' },
          { name: 'Utility room', done: false, note: 'Not started' },
        ].map((room) => (
          <div className={s.roomItem} key={room.name}>
            {room.done ? <CircleCheck size={16} /> : <House size={16} />}
            <span>{room.name}</span>
            <span>{room.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function InspectionPage() {
  return (
    <>
      <div className={s.pageHeaderRow}>
        <PageHeader
          category="Patterns / Property inspection"
          title="One system. Real context."
          description="A small inspection mockup showing how Satvey’s components work together. Every finding, address, and transcript here is sample content."
        />
        <Badge>INTERACTIVE MOCKUP</Badge>
      </div>
      <Tabs.Root defaultValue="inspection">
        <Tabs.List className={s.inspectionTabs} aria-label="Inspection mockup views">
          <Tabs.Trigger value="inspection" className={s.inspectionTab}>
            Inspection overview
          </Tabs.Trigger>
          <Tabs.Trigger value="voice" className={s.inspectionTab}>
            Voice & observations
          </Tabs.Trigger>
          <Tabs.Trigger value="report" className={s.inspectionTab}>
            Report preview
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="inspection">
          <div className={s.inspectionGrid}>
            <div className={s.stack}>
              <PropertyCard />
              <RoomChecklist />
            </div>
            <div className={s.stack}>
              <div className={s.panel}>
                <div className={s.row} style={{ justifyContent: 'space-between' }}>
                  <div>
                    <h2 className={s.subheading} style={{ marginBottom: 5 }}>
                      Living room
                    </h2>
                    <p className={s.muted}>Ground floor · Interior condition</p>
                  </div>
                  <Avatar />
                </div>
              </div>
              <FindingPreview />
              <Alert tone="info" title="Designed around human judgment.">
                AI suggestions and inspector approval are separate states. A finding only becomes
                approved after a person reviews it.
              </Alert>
              <div className={s.panel}>
                <h3 className={s.subheading}>Building blocks in this pattern</h3>
                <div className={s.row}>
                  <Badge>Card</Badge>
                  <Badge>Avatar</Badge>
                  <Badge>Status badge</Badge>
                  <Badge>Progress</Badge>
                  <Badge>Button</Badge>
                  <Badge>Dialog</Badge>
                  <Badge>Alert</Badge>
                </div>
              </div>
            </div>
          </div>
        </Tabs.Content>
        <Tabs.Content value="voice">
          <div className={s.twoColumns}>
            <div className={s.panel}>
              <h2 className={s.subheading}>Speak naturally. Keep the detail.</h2>
              <p className={s.sectionDescription}>
                A simulated dictation interface. Start the demo to see sample words appear, then
                edit the text as you would an observation.
              </p>
              <DictationExample />
            </div>
            <div className={s.stack}>
              <div className={s.panel}>
                <h3 className={s.subheading}>An inspector’s words, in context.</h3>
                <p className={s.sectionDescription}>
                  The voice pattern brings capture controls, elapsed time, transcript text, and
                  recording status into one focused area.
                </p>
                <div className={s.row}>
                  <Badge tone="ai" icon>
                    Voice pattern
                  </Badge>
                  <Badge>Living room</Badge>
                </div>
              </div>
              <Alert title="A design preview, from start to finish.">
                No audio is recorded or transmitted. Text appears from a predefined sample, so the
                experience is consistent across browsers.
              </Alert>
            </div>
          </div>
        </Tabs.Content>
        <Tabs.Content value="report">
          <div className={s.panel} style={{ maxWidth: 850, margin: '0 auto' }}>
            <div className={s.reportHeader}>
              <div>
                <BrandMark size={29} />
                satvey.
              </div>
              <Badge>ILLUSTRATIVE REPORT</Badge>
              <h2 style={{ marginTop: 17 }}>Property condition report</h2>
              <p>
                Willow House · 24 Willow Lane, Amsterdam
                <br />
                Inspector: Emma Lewis · Sample inspection
              </p>
            </div>
            <div className={s.twoColumns}>
              <div>
                <h3 className={s.subheading}>A clear view of the property.</h3>
                <p className={s.sectionDescription}>
                  A composed document pattern using the same typography, spacing, colors, and status
                  language as the rest of Satvey.
                </p>
              </div>
              <div className={s.row}>
                <Badge tone="success" icon>
                  8 rooms complete
                </Badge>
                <Badge tone="warning" icon>
                  3 to review
                </Badge>
              </div>
            </div>
            <h3 className={s.subheading}>Sample observations</h3>
            <div className={s.tableWrap}>
              <table className={s.tokenTable}>
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Observation</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td data-label="Location">Living room</td>
                    <td data-label="Observation">Minor surface wear near entrance</td>
                    <td data-label="Status">
                      <Badge tone="warning" dot>
                        Needs review
                      </Badge>
                    </td>
                  </tr>
                  <tr>
                    <td data-label="Location">Kitchen</td>
                    <td data-label="Observation">Surfaces in good condition</td>
                    <td data-label="Status">
                      <Badge tone="success" dot>
                        Approved
                      </Badge>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className={cx(s.smallNote, s.row)} style={{ marginTop: 25 }}>
              <FileText size={14} />A visual report example. No inspection report is generated or
              submitted.
            </div>
          </div>
        </Tabs.Content>
      </Tabs.Root>
      <div className={s.principleStrip}>
        <span>
          <ClipboardCheck size={17} />
          Made for the way you inspect.
        </span>
        <span>
          <Sparkles size={17} />
          Expertise, thoughtfully supported.
        </span>
      </div>
    </>
  );
}
