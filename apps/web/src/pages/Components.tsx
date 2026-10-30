import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Accordion, AlertDialog, DropdownMenu, Popover, RadioGroup, Slider, Tabs } from 'radix-ui';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  FileText,
  House,
  Info,
  Pencil,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  IconButton,
  Progress,
  Select,
  Switch,
  Tooltip,
  cx,
  useToast,
} from '../components/ui';
import type { ButtonProps } from '../components/ui';
import { ButtonExamples, FormExamples, PropertyCard, StatusExamples } from '../components/examples';
import { PageHeader } from '../components/PageHeader';
import s from './pages.module.css';

function DemoBlock({
  title,
  description,
  code,
  children,
}: {
  title: string;
  description: string;
  code: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Tabs.Root defaultValue="preview" className={s.demoBlock}>
      <div className={s.demoHeader}>
        <h2>{title}</h2>
        <Tabs.List className={s.componentTabs} aria-label={`${title} view`}>
          <Tabs.Trigger className={s.componentTab} value="preview">
            Preview
          </Tabs.Trigger>
          <Tabs.Trigger className={s.componentTab} value="code">
            Code
          </Tabs.Trigger>
        </Tabs.List>
      </div>
      <Tabs.Content value="preview" className={s.demoContent} aria-describedby={id}>
        {children}
      </Tabs.Content>
      <Tabs.Content value="code">
        <pre className={s.demoCode}>
          <code>{code}</code>
        </pre>
      </Tabs.Content>
      <p className={s.demoFooter} id={id}>
        {description}
      </p>
    </Tabs.Root>
  );
}

function Buttons() {
  const [variant, setVariant] = useState<NonNullable<ButtonProps['variant']>>('primary');
  const [size, setSize] = useState<NonNullable<ButtonProps['size']>>('md');
  const [disabled, setDisabled] = useState(false);
  const notify = useToast();
  return (
    <>
      <PageHeader
        category="Components / Actions"
        title="A confident next step."
        description="Buttons make intent clear. Olive leads the way, outlined actions support it, and quieter buttons keep the interface in balance."
      />
      <DemoBlock
        title="Buttons & actions"
        description="Use one primary action per task area. Keep labels short, specific, and action-oriented."
        code={
          '<Button icon={<Plus size={16} />}>New inspection</Button>\n<Button variant="secondary">View details</Button>\n<Button variant="ghost">Learn more</Button>\n<Button variant="destructive">Delete finding</Button>'
        }
      >
        <ButtonExamples />
        <div className={s.row} style={{ marginTop: 20 }}>
          <Button
            variant="destructive"
            icon={<Trash2 size={15} />}
            onClick={() =>
              notify({
                title: 'Destructive style preview',
                description: 'Actual destructive actions should ask for confirmation.',
              })
            }
          >
            Delete finding
          </Button>
        </div>
      </DemoBlock>
      <DemoBlock
        title="State reference"
        description="All states use the same component. The hover and focus examples are pinned here for comparison."
        code={
          '<Button>Default</Button>\n<Button loading>Saving…</Button>\n<Button disabled>Disabled</Button>'
        }
      >
        <div className={s.stateGrid}>
          <div className={s.stateCell}>
            <span>Default</span>
            <Button onClick={() => notify({ title: 'Default state selected' })}>Continue</Button>
          </div>
          <div className={s.stateCell}>
            <span>Hover</span>
            <Button
              className={s.forcedHover}
              onClick={() => notify({ title: 'Hover state selected' })}
            >
              Continue
            </Button>
          </div>
          <div className={s.stateCell}>
            <span>Focus visible</span>
            <Button
              className={s.forcedFocus}
              onClick={() => notify({ title: 'Focus state selected' })}
            >
              Continue
            </Button>
          </div>
          <div className={s.stateCell}>
            <span>Disabled</span>
            <Button disabled>Continue</Button>
          </div>
          <div className={s.stateCell}>
            <span>Loading</span>
            <Button loading>Saving…</Button>
          </div>
        </div>
      </DemoBlock>
      <DemoBlock
        title="Make it yours"
        description="Sizes change emphasis, while every button keeps a touch area of at least 44px. The same props work on every screen."
        code={`<Button variant="${variant}" size="${size}"${disabled ? ' disabled' : ''}>\n  Continue inspection\n</Button>`}
      >
        <div className={s.twoColumns}>
          <div className={s.stack}>
            <Select
              label="Variant"
              items={['primary', 'secondary', 'ghost', 'destructive']}
              value={variant}
              onValueChange={(v) => setVariant(v as typeof variant)}
            />
            <Select
              label="Size"
              items={['sm', 'md', 'lg']}
              value={size}
              onValueChange={(v) => setSize(v as typeof size)}
            />
            <Switch label="Disabled state" checked={disabled} onCheckedChange={setDisabled} />
          </div>
          <div className={s.emptyState}>
            <Button
              variant={variant}
              size={size}
              disabled={disabled}
              onClick={() =>
                notify({ title: 'Playground action selected', description: `${variant} / ${size}` })
              }
            >
              Continue inspection
              <ArrowRight size={15} />
            </Button>
          </div>
        </div>
      </DemoBlock>
    </>
  );
}

function Forms() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [severity, setSeverity] = useState('Low');
  const [confidence, setConfidence] = useState([75]);
  const [selected, setSelected] = useState(false);
  const [assist, setAssist] = useState(true);
  const groupId = useId();
  const notify = useToast();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter a property name to continue.');
      return;
    }
    setError('');
    notify({
      title: 'Looks good.',
      description: 'Form validation preview complete. No property was created.',
    });
  }
  return (
    <>
      <PageHeader
        category="Components / Forms"
        title="Less friction. More flow."
        description="Familiar controls with clear labels, useful hints, and honest feedback. Designed to be comfortable at a desk and easy to use in the field."
      />
      <DemoBlock
        title="Inputs & selection"
        description="Labels stay visible after a value is entered. A placeholder is a helpful example, never a replacement for a label."
        code={
          '<Field label="Property name" defaultValue="Willow House" />\n<Select label="Room" items={rooms} value={room} onValueChange={setRoom} />\n<Checkbox label="Include in report" checked={included} onCheckedChange={setIncluded} />\n<Switch label="AI assistance" checked={enabled} onCheckedChange={setEnabled} />'
        }
      >
        <FormExamples />
      </DemoBlock>
      <DemoBlock
        title="Field states & validation"
        description="Explain what needs attention in plain language. Associate each error with its field and keep the entered value intact."
        code={
          '<Field label="Property name" required\n  value={name} onChange={e => setName(e.target.value)}\n  error={error} hint="Use a name your team will recognize." />'
        }
      >
        <form className={s.stack} onSubmit={submit} noValidate>
          <div className={s.twoColumns}>
            <Field
              label="Property name"
              required
              placeholder="e.g. Willow House"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError('');
              }}
              error={error}
              hint="Use a name your team will recognize."
            />
            <Field
              label="Inspection reference"
              value="STV-2026-0042"
              disabled
              hint="Assigned automatically in the product."
            />
          </div>
          <div className={s.labeledBlock}>
            <label htmlFor="sample-finding">Observation</label>
            <textarea
              id="sample-finding"
              className={s.textarea}
              placeholder="Describe what you’ve observed…"
              rows={3}
            />
          </div>
          <div>
            <Button type="submit">
              Validate sample
              <Check size={15} />
            </Button>
          </div>
        </form>
      </DemoBlock>
      <DemoBlock
        title="Choice controls"
        description="Use radio buttons for one choice, checkboxes for independent choices, and switches for on/off preferences."
        code={
          '<RadioGroup.Root value={severity} onValueChange={setSeverity}>\n  {/* Labeled RadioGroup.Item elements */}\n</RadioGroup.Root>\n<Checkbox label="Include photographs" checked={selected} onCheckedChange={setSelected} />'
        }
      >
        <div className={s.stack}>
          <div>
            <p className={s.subheading} id={`${groupId}-label`}>
              Finding severity
            </p>
            <RadioGroup.Root
              className={s.radioGroup}
              value={severity}
              onValueChange={setSeverity}
              aria-labelledby={`${groupId}-label`}
            >
              {['Low', 'Medium', 'High'].map((value) => (
                <div key={value} className={s.radioItemWrap}>
                  <RadioGroup.Item id={`${groupId}-${value}`} value={value} className={s.radioItem}>
                    <RadioGroup.Indicator className={s.radioIndicator} />
                  </RadioGroup.Item>
                  <label htmlFor={`${groupId}-${value}`}>{value}</label>
                </div>
              ))}
            </RadioGroup.Root>
          </div>
          <div className={s.twoColumns}>
            <Checkbox
              label="Include photographs"
              checked={selected}
              onCheckedChange={setSelected}
            />
            <Switch label="Show AI suggestions" checked={assist} onCheckedChange={setAssist} />
            <Checkbox label="Disabled option" checked disabled />
            <Switch label="Unavailable preference" disabled />
          </div>
        </div>
      </DemoBlock>
      <DemoBlock
        title="Range selection"
        description="Support keyboard arrows and touch. Always show the current value alongside a descriptive label."
        code={
          '<Slider.Root value={confidence} onValueChange={setConfidence}\n  min={0} max={100} step={5} aria-label="Confidence threshold">\n  <Slider.Track><Slider.Range /></Slider.Track>\n  <Slider.Thumb aria-label="Confidence threshold" />\n</Slider.Root>'
        }
      >
        <div style={{ maxWidth: 500 }}>
          <div className={s.progressLabel} style={{ fontSize: 12 }}>
            <span>Confidence threshold</span>
            <strong>{confidence[0]}%</strong>
          </div>
          <Slider.Root
            className={s.slider}
            value={confidence}
            onValueChange={setConfidence}
            min={0}
            max={100}
            step={5}
          >
            <Slider.Track className={s.sliderTrack}>
              <Slider.Range className={s.sliderRange} />
            </Slider.Track>
            <Slider.Thumb className={s.sliderThumb} aria-label="Confidence threshold" />
          </Slider.Root>
          <p className={s.muted}>A component example; this does not filter live AI results.</p>
        </div>
      </DemoBlock>
    </>
  );
}

const properties = [
  {
    name: 'Willow House',
    address: '24 Willow Lane',
    type: 'Residential',
    status: 'In progress',
    tone: 'info' as const,
    progress: 68,
  },
  {
    name: 'Oak Residence',
    address: '8 Oak Avenue',
    type: 'Residential',
    status: 'Needs review',
    tone: 'warning' as const,
    progress: 95,
  },
  {
    name: 'The Corner Studio',
    address: '16 Linden Street',
    type: 'Commercial',
    status: 'Approved',
    tone: 'success' as const,
    progress: 100,
  },
  {
    name: 'Cedar Cottage',
    address: '3 Cedar Grove',
    type: 'Residential',
    status: 'Draft',
    tone: 'neutral' as const,
    progress: 0,
  },
  {
    name: 'Elm Apartments',
    address: '42 Elm Road',
    type: 'Residential',
    status: 'In progress',
    tone: 'info' as const,
    progress: 32,
  },
  {
    name: 'Park Offices',
    address: '9 Park Square',
    type: 'Commercial',
    status: 'Approved',
    tone: 'success' as const,
    progress: 100,
  },
];
function DataDisplay() {
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('all');
  const selectedRows =
    tab === 'all' ? properties : properties.filter((property) => property.status === 'In progress');
  const totalPages = Math.ceil(selectedRows.length / 3);
  const rows = selectedRows.slice((page - 1) * 3, page * 3);
  return (
    <>
      <PageHeader
        category="Components / Information"
        title="The bigger picture, clearly."
        description="Cards, lists, and tables help observations find their place. Show the right context, make status legible, and let the important details lead."
      />
      <DemoBlock
        title="Cards & progress"
        description="Keep related information together. Progress is labeled, meaningful, and readable without relying on color."
        code={
          '<Card>\n  <PropertySummary property={sampleProperty} />\n  <Progress value={68} label="Inspection progress" />\n</Card>'
        }
      >
        <div className={s.twoColumns}>
          <div style={{ maxWidth: 420 }}>
            <PropertyCard />
          </div>
          <div className={s.stack}>
            <div>
              <h3 className={s.subheading}>Status badges</h3>
              <StatusExamples />
            </div>
            <div>
              <h3 className={s.subheading}>People & teams</h3>
              <div className={s.row}>
                <Avatar />
                <Avatar initials="JM" label="James Miller" />
                <div className={s.avatarStack}>
                  <Avatar initials="EL" label="Emma Lewis" />
                  <Avatar initials="JM" label="James Miller" />
                  <Avatar initials="SK" label="Sarah Kim" />
                </div>
              </div>
            </div>
            <div>
              <h3 className={s.subheading}>Inspection progress</h3>
              <div className={s.progressLabel}>
                <span>8 of 12 rooms</span>
                <strong>68%</strong>
              </div>
              <Progress value={68} />
            </div>
          </div>
        </div>
      </DemoBlock>
      <DemoBlock
        title="Tables, tabs & pagination"
        description="Structured rows on desktop become labeled cards on phones. Tabs filter the sample data; pagination keeps the list manageable."
        code={
          '<Tabs.Root value={filter} onValueChange={setFilter}>…</Tabs.Root>\n<table>\n  <thead>…</thead>\n  <tbody>{properties.map(property => <PropertyRow key={property.id} />)}</tbody>\n</table>'
        }
      >
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            setTab(value);
            setPage(1);
          }}
        >
          <Tabs.List className={s.componentTabs} aria-label="Filter sample inspections">
            <Tabs.Trigger value="all" className={s.componentTab}>
              All inspections
            </Tabs.Trigger>
            <Tabs.Trigger value="active" className={s.componentTab}>
              In progress
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value={tab} style={{ marginTop: 18 }}>
            <div className={s.tableWrap}>
              <table className={s.tokenTable}>
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((property) => (
                    <tr key={property.name}>
                      <td>
                        <div className={s.tableProperty}>
                          <span className={s.tablePropertyIcon}>
                            <House size={16} />
                          </span>
                          <div>
                            <strong>{property.name}</strong>
                            <small>{property.address}</small>
                          </div>
                        </div>
                      </td>
                      <td data-label="Type">{property.type}</td>
                      <td data-label="Status">
                        <Badge tone={property.tone} dot>
                          {property.status}
                        </Badge>
                      </td>
                      <td data-label="Progress">{property.progress}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className={s.pagination}>
                <span>
                  Showing {(page - 1) * 3 + 1}–{Math.min(page * 3, selectedRows.length)} of{' '}
                  {selectedRows.length}
                </span>
                <nav className={s.paginationControls} aria-label="Table pagination">
                  <IconButton
                    label="Previous page"
                    variant="secondary"
                    disabled={page === 1}
                    onClick={() => setPage((v) => v - 1)}
                  >
                    <ChevronLeft size={15} />
                  </IconButton>
                  <span>
                    Page {page} of {totalPages}
                  </span>
                  <IconButton
                    label="Next page"
                    variant="secondary"
                    disabled={page === totalPages}
                    onClick={() => setPage((v) => v + 1)}
                  >
                    <ChevronRight size={15} />
                  </IconButton>
                </nav>
              </div>
            </div>
          </Tabs.Content>
        </Tabs.Root>
      </DemoBlock>
      <DemoBlock
        title="Disclosure & wayfinding"
        description="Accordions keep secondary detail within reach. Breadcrumbs help people understand their place in a larger task."
        code={
          '<Accordion.Root type="single" collapsible>\n  <Accordion.Item value="room">\n    <Accordion.Header><Accordion.Trigger>Living room</Accordion.Trigger></Accordion.Header>\n    <Accordion.Content>…</Accordion.Content>\n  </Accordion.Item>\n</Accordion.Root>'
        }
      >
        <div className={s.stack}>
          <nav className={s.row} aria-label="Sample breadcrumb" style={{ fontSize: 12 }}>
            <Link to="/" className={s.textLink}>
              Design system
            </Link>
            <ChevronRight size={13} />
            <Link to="/design-system/patterns/inspection" className={s.textLink}>
              Inspection pattern
            </Link>
            <ChevronRight size={13} />
            <span aria-current="page">Room details</span>
          </nav>
          <Accordion.Root type="single" defaultValue="living" collapsible className={s.accordion}>
            {[
              {
                id: 'living',
                title: 'Living room',
                text: 'Walls, floors, windows, and fixtures. One sample finding is awaiting review.',
              },
              {
                id: 'kitchen',
                title: 'Kitchen',
                text: 'Sample room: fittings, appliances, surfaces, plumbing, and ventilation.',
              },
              {
                id: 'bedroom',
                title: 'Bedroom',
                text: 'Sample room: finishes, lighting, windows, and built-in storage.',
              },
            ].map((item) => (
              <Accordion.Item key={item.id} value={item.id} className={s.accordionItem}>
                <Accordion.Header>
                  <Accordion.Trigger className={s.accordionTrigger}>
                    {item.title}
                    <ChevronDown size={15} />
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Content className={s.accordionContent}>{item.text}</Accordion.Content>
              </Accordion.Item>
            ))}
          </Accordion.Root>
        </div>
      </DemoBlock>
    </>
  );
}

function Feedback() {
  const notify = useToast();
  const [empty, setEmpty] = useState(false);
  return (
    <>
      <PageHeader
        category="Components / Feedback"
        title="Helpful, without the noise."
        description="A good interface tells you what happened and what comes next. Feedback should be timely, understandable, and easy to act on."
      />
      <DemoBlock
        title="Alerts & status"
        description="Use a persistent alert when context matters. Reserve urgent treatment for issues that actually require attention."
        code={
          '<Alert tone="success" title="Finding approved">Ready for the report.</Alert>\n<Alert tone="warning" title="A second look">Review the suggested finding.</Alert>\n<Badge tone="ai" icon>AI suggested</Badge>'
        }
      >
        <div className={s.stack}>
          <Alert tone="success" title="Finding approved">
            This observation has been reviewed by an inspector.
          </Alert>
          <Alert tone="warning" title="A second look, when you’re ready.">
            A suggested finding needs your judgment before it’s included in the report.
          </Alert>
          <Alert tone="info" title="Your expertise comes first.">
            AI suggestions are a starting point. Review, edit, or dismiss each one.
          </Alert>
          <Alert tone="danger" title="This change couldn’t be saved.">
            Check your connection and try again. Your observation is still here.
          </Alert>
          <StatusExamples />
        </div>
      </DemoBlock>
      <DemoBlock
        title="Toasts"
        description="Brief confirmation for an action that just happened. Toasts are announced to assistive technology and can be dismissed."
        code={
          'const notify = useToast();\nnotify({\n  title: "Changes saved",\n  description: "Your sample observation is up to date.",\n});'
        }
      >
        <div className={s.row}>
          <Button
            icon={<Check size={15} />}
            onClick={() =>
              notify({
                title: 'Changes saved',
                description: 'Your sample observation is up to date.',
              })
            }
          >
            Show confirmation
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              notify({
                title: 'A small, helpful update.',
                description: 'This notification disappears after a few seconds.',
              })
            }
          >
            Show notification
          </Button>
        </div>
      </DemoBlock>
      <DemoBlock
        title="Empty & error states"
        description="An empty state gives context and a useful next step. Keep error recovery calm, specific, and close to the problem."
        code={
          '<EmptyState\n  title="A fresh starting point."\n  description="Your observations will find a home here."\n  action={<Button>Add an observation</Button>}\n/>'
        }
      >
        <div className={s.twoColumns}>
          <div className={s.emptyState}>
            <FileText size={27} />
            <h3>{empty ? 'And there it is.' : 'A fresh starting point.'}</h3>
            <p>
              {empty
                ? 'A sample observation has been added to this empty-state preview.'
                : 'Your observations will find a home here. Start with the first detail you notice.'}
            </p>
            <Button
              size="sm"
              variant={empty ? 'secondary' : 'primary'}
              icon={empty ? undefined : <Plus size={14} />}
              onClick={() => setEmpty((v) => !v)}
            >
              {empty ? 'Reset preview' : 'Add sample observation'}
            </Button>
          </div>
          <div className={s.emptyState}>
            <CircleHelp size={27} />
            <h3>A momentary pause.</h3>
            <p>
              We couldn’t load this sample view. A clear retry action helps you pick up where you
              left off.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                notify({
                  title: 'Retry interaction preview',
                  description: 'This is a designed error state, with no network request.',
                })
              }
            >
              Try again
            </Button>
          </div>
        </div>
      </DemoBlock>
      <DemoBlock
        title="Loading skeletons"
        description="Reserve space while content loads to reduce layout movement. Animation follows the reduced-motion preference."
        code={
          '<div aria-busy="true" aria-label="Loading property summary">\n  <Skeleton height={100} />\n  <Skeleton width="70%" />\n</div>'
        }
      >
        <div
          className={s.skeletonCard}
          role="status"
          aria-busy="true"
          aria-label="Loading property summary example"
        >
          <div className={s.skeleton} style={{ height: 100, marginBottom: 20 }} />
          <div className={s.skeleton} style={{ height: 15, width: '65%', marginBottom: 12 }} />
          <div className={s.skeleton} style={{ height: 10, width: '90%', marginBottom: 8 }} />
          <div className={s.skeleton} style={{ height: 10, width: '75%' }} />
        </div>
      </DemoBlock>
    </>
  );
}

function Overlays() {
  const notify = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <>
      <PageHeader
        category="Components / Overlays"
        title="The right detail, in reach."
        description="Thoughtful layers bring context forward without losing your place. Radix handles keyboard navigation, dismissal, and focus management."
      />
      <DemoBlock
        title="Dialogs"
        description="Dialogs focus a single task. Escape closes the preview, focus stays inside, and returns to the trigger afterward."
        code={
          '<Dialog title="Review observation" description="Your expertise makes the difference."\n  trigger={<Button>Open dialog</Button>}>\n  {/* Focused task content */}\n</Dialog>'
        }
      >
        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="A little closer look."
          description="A focused space for the detail that matters."
          trigger={
            <Button>
              Open dialog
              <ArrowRight size={15} />
            </Button>
          }
        >
          <div className={s.stack}>
            <Badge tone="ai" icon>
              AI suggested · Sample finding
            </Badge>
            <p className={s.muted}>
              Minor surface wear is visible near the living room entrance. An inspector can add
              context before approving a finding.
            </p>
            <Field label="Observation title" defaultValue="Minor surface wear" />
            <div className={s.dialogActions}>
              <Button variant="secondary" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setDialogOpen(false);
                  notify({
                    title: 'Dialog preview complete',
                    description: 'Focus has returned to where you started.',
                  });
                }}
              >
                Save sample
              </Button>
            </div>
          </div>
        </Dialog>
      </DemoBlock>
      <DemoBlock
        title="Confirmation dialogs"
        description="Make consequences clear before a destructive action. The safer option receives initial focus."
        code={
          '<AlertDialog.Root>\n  <AlertDialog.Trigger asChild><Button variant="destructive">Delete sample</Button></AlertDialog.Trigger>\n  <AlertDialog.Content>\n    <AlertDialog.Title>Remove this sample finding?</AlertDialog.Title>\n    <AlertDialog.Cancel asChild><Button variant="secondary">Keep finding</Button></AlertDialog.Cancel>\n    <AlertDialog.Action asChild><Button variant="destructive">Remove sample</Button></AlertDialog.Action>\n  </AlertDialog.Content>\n</AlertDialog.Root>'
        }
      >
        <AlertDialog.Root>
          <AlertDialog.Trigger asChild>
            <Button variant="destructive" icon={<Trash2 size={15} />}>
              Delete sample
            </Button>
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className={s.alertOverlay} />
            <AlertDialog.Content className={s.alertDialog}>
              <AlertDialog.Title className={s.alertDialogTitle}>
                Remove this sample finding?
              </AlertDialog.Title>
              <AlertDialog.Description className={s.alertDialogDescription}>
                In the product, this would remove the finding from the inspection. This is a
                component preview; no data will be deleted.
              </AlertDialog.Description>
              <div className={s.dialogActions}>
                <AlertDialog.Cancel asChild>
                  <Button variant="secondary">Keep finding</Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <Button
                    variant="destructive"
                    onClick={() =>
                      notify({
                        title: 'Confirmation preview complete',
                        description: 'No actual findings were removed.',
                      })
                    }
                  >
                    Remove sample
                  </Button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </DemoBlock>
      <DemoBlock
        title="Menus, popovers & tooltips"
        description="Menus group actions. Popovers reveal supporting context. Tooltips clarify icons on hover and keyboard focus."
        code={
          '<DropdownMenu.Root>…</DropdownMenu.Root>\n<Popover.Root>…</Popover.Root>\n<Tooltip text="More about AI suggestions">\n  <IconButton label="More about AI suggestions"><Info /></IconButton>\n</Tooltip>'
        }
      >
        <div className={s.row}>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button variant="secondary">
                Finding actions
                <ChevronDown size={15} />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className={s.dropdownContent} sideOffset={8} align="start">
                {[
                  { text: 'Edit sample', Icon: Pencil },
                  { text: 'Duplicate sample', Icon: Copy },
                  { text: 'View in report', Icon: FileText },
                ].map(({ text, Icon }) => (
                  <DropdownMenu.Item
                    className={s.dropdownItem}
                    key={text}
                    onSelect={() =>
                      notify({ title: text, description: 'Menu interaction preview.' })
                    }
                  >
                    <Icon size={15} />
                    {text}
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator className={s.dropdownSeparator} />
                <DropdownMenu.Item
                  className={cx(s.dropdownItem, s.dangerText)}
                  onSelect={() =>
                    notify({
                      title: 'Dismiss sample',
                      description: 'Menu interaction preview. No data was changed.',
                    })
                  }
                >
                  <Trash2 size={15} />
                  Dismiss sample
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <Popover.Root>
            <Popover.Trigger asChild>
              <Button variant="secondary" icon={<Sparkles size={15} />}>
                About AI assistance
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className={s.popoverContent} sideOffset={8} collisionPadding={16}>
                <h3>Your expertise, supported.</h3>
                <p>
                  AI can suggest what to look at. An inspector reviews each finding and makes the
                  final decision.
                </p>
                <Badge tone="ai" icon>
                  Sample guidance
                </Badge>
                <Popover.Close asChild>
                  <IconButton label="Close popover" className={s.popoverClose}>
                    <X size={15} />
                  </IconButton>
                </Popover.Close>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <Tooltip text="A little context, right when it helps.">
            <IconButton label="More about this example" variant="secondary">
              <Info size={17} />
            </IconButton>
          </Tooltip>
          <Tooltip text="Settings example">
            <IconButton
              label="Sample settings"
              onClick={() =>
                notify({
                  title: 'Settings icon selected',
                  description: 'A tooltip supplements the accessible button label.',
                })
              }
            >
              <Settings2 size={18} />
            </IconButton>
          </Tooltip>
        </div>
      </DemoBlock>
    </>
  );
}

export function ComponentsPage() {
  const { section } = useParams();
  if (section === 'buttons') return <Buttons />;
  if (section === 'forms') return <Forms />;
  if (section === 'data-display') return <DataDisplay />;
  if (section === 'feedback') return <Feedback />;
  if (section === 'overlays') return <Overlays />;
  return (
    <>
      <PageHeader
        category="Components"
        title="The essentials, together."
        description="Explore the component library using the navigation."
      />
      <Link className={s.solidLink} to="/design-system/components/buttons">
        Explore buttons
        <ArrowRight size={15} />
      </Link>
    </>
  );
}
