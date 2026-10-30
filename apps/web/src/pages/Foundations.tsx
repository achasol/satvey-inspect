import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Bell,
  BookOpen,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Copy,
  Download,
  Eye,
  FileText,
  Heart,
  House,
  Image,
  Layers3,
  LayoutGrid,
  MapPin,
  Menu,
  Mic,
  MonitorSmartphone,
  MoreHorizontal,
  MousePointer2,
  Palette,
  Plus,
  Ruler,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sprout,
  Sun,
  Trash2,
  Type,
  Upload,
  User,
  WifiOff,
  X,
} from 'lucide-react';
import { Alert, Badge, Button, IconButton, Field, cx, useToast } from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import s from './pages.module.css';

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}
const colors = [
  {
    name: 'Warm ivory',
    hex: '#F7F5EF',
    token: '--canvas',
    use: 'Our calm, everyday canvas.',
    foreground: '#2D332B',
  },
  {
    name: 'Satvey olive',
    hex: '#4E5D43',
    token: '--primary',
    use: 'Confident actions and identity.',
    foreground: '#FFFFFF',
  },
  {
    name: 'Warm charcoal',
    hex: '#2D332B',
    token: '--text',
    use: 'Clear, grounded typography.',
    foreground: '#FFFFFF',
  },
  {
    name: 'Soft linen',
    hex: '#EFECE3',
    token: '--surface-muted',
    use: 'Quiet separation and structure.',
    foreground: '#2D332B',
  },
  {
    name: 'Earthy clay',
    hex: '#9C5D43',
    token: '--accent',
    use: 'A little warmth, used sparingly.',
    foreground: '#FFFFFF',
  },
  {
    name: 'Natural white',
    hex: '#FFFFFF',
    token: '--surface',
    use: 'A fresh surface for your content.',
    foreground: '#2D332B',
  },
];

function Colors() {
  const notify = useToast();
  const handleCopy = async (hex: string) => {
    try {
      await copy(hex);
      notify({ title: `${hex} copied`, description: 'A little piece of the Satvey palette.' });
    } catch {
      notify({ title: 'Select the value to copy it', description: hex });
    }
  };
  const ramp = [
    '#eef0e8',
    '#e3e7d9',
    '#cad2bc',
    '#a5af92',
    '#869471',
    '#6b795c',
    '#4e5d43',
    '#2d332b',
  ];
  const tokens = [
    ['--canvas', '#F7F5EF', 'Page background'],
    ['--surface', '#FFFFFF', 'Cards, inputs, and overlays'],
    ['--text', '#2D332B', 'Primary content'],
    ['--text-muted', '#646B5D', 'Supporting content'],
    ['--primary', '#4E5D43', 'Primary actions and selection'],
    ['--success', '#3E633E', 'Inspector-approved or successful'],
    ['--warning', '#805F20', 'Needs attention or review'],
    ['--danger', '#A33A32', 'Critical findings or destructive actions'],
    ['--info', '#46636A', 'Neutral informational feedback'],
  ];
  return (
    <>
      <PageHeader
        category="Foundations / 01"
        title="Rooted in nature."
        description="A grounded palette of ivory, olive, and warm neutrals. Color creates hierarchy, brings clarity, and leaves room for the important details."
      />
      <div className={s.tokenGrid}>
        {colors.map((color) => (
          <div className={s.colorCard} key={color.token}>
            <div
              className={s.colorBlock}
              style={{ background: color.hex, color: color.foreground }}
            >
              <span>Aa</span>
              <Badge>{color.hex}</Badge>
            </div>
            <div className={s.colorCardInfo}>
              <div>
                <h3>{color.name}</h3>
                <IconButton
                  label={`Copy ${color.name} hex value`}
                  onClick={() => handleCopy(color.hex)}
                >
                  <Copy size={14} />
                </IconButton>
              </div>
              <p>{color.use}</p>
              <code>var({color.token})</code>
            </div>
          </div>
        ))}
      </div>
      <section className={s.contentSection}>
        <h2>The olive spectrum</h2>
        <p className={s.sectionDescription}>
          From soft, supportive surfaces to the deepest text tones. Use semantic tokens in
          components so the system can evolve together.
        </p>
        <div className={s.paletteRamp}>
          {ramp.map((hex, index) => (
            <div
              key={hex}
              className={s.rampSwatch}
              style={{ background: hex, color: index >= 5 ? '#fff' : '#1f251c' }}
            >
              <span>{[50, 100, 200, 300, 400, 500, 700, 900][index]}</span>
              <span>{hex.toUpperCase()}</span>
            </div>
          ))}
        </div>
      </section>
      <section className={s.contentSection}>
        <h2>Color with meaning</h2>
        <p className={s.sectionDescription}>
          Status always combines color with a label or icon. AI suggestions remain distinct from
          inspector approval.
        </p>
        <div className={s.row}>
          <Badge tone="success" icon>
            Approved
          </Badge>
          <Badge tone="warning" icon>
            Needs review
          </Badge>
          <Badge tone="danger" icon>
            Critical
          </Badge>
          <Badge tone="info" icon>
            In progress
          </Badge>
          <Badge tone="ai" icon>
            AI suggested
          </Badge>
          <Badge>Draft</Badge>
        </div>
      </section>
      <section className={s.contentSection}>
        <h2>Semantic tokens</h2>
        <p className={s.sectionDescription}>
          Name the role, not the color. These CSS properties are the public foundation for every
          component.
        </p>
        <div className={s.tableWrap}>
          <table className={s.tokenTable}>
            <thead>
              <tr>
                <th>Token</th>
                <th>Value</th>
                <th>Intended use</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map(([token, hex, use]) => (
                <tr key={token}>
                  <td>
                    <span className={s.tokenName}>
                      <i className={s.tokenDot} style={{ background: hex }} />
                      <code>{token}</code>
                    </span>
                  </td>
                  <td data-label="Value">{hex}</td>
                  <td data-label="Use">{use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className={s.contentSection}>
        <Alert tone="success" title="Soft colors. Strong contrast.">
          Charcoal on ivory: 11.89:1. Muted text on ivory: 5.06:1. White on olive: 7.07:1. White on
          clay: 5.17:1. These pairings exceed the 4.5:1 target for normal text.
        </Alert>
      </section>
    </>
  );
}

function Typography() {
  const [sample, setSample] = useState('Clarity comes naturally.');
  const scale = [
    ['Display', 72, 'Newsreader', 'A little more clarity.'],
    ['Heading 1', 56, 'Newsreader', 'Every detail matters.'],
    ['Heading 2', 28, 'DM Sans', 'A confident next step.'],
    ['Heading 3', 20, 'DM Sans', 'Your inspection, at a glance.'],
    ['Body', 16, 'DM Sans', 'Clear observations lead to better decisions.'],
    ['Supporting', 14, 'DM Sans', 'Last updated a moment ago.'],
    ['Label', 12, 'DM Sans', 'LIVING ROOM · GROUND FLOOR'],
  ] as const;
  return (
    <>
      <PageHeader
        category="Foundations / 02"
        title="Clarity with character."
        description="A thoughtful pairing: Newsreader brings warmth to our biggest moments. DM Sans keeps every observation and interaction effortlessly clear."
      />
      <div className={s.fontPairing}>
        <div className={s.fontCard}>
          <small>THE EXPRESSIVE VOICE</small>
          <div className={s.fontSample} style={{ fontFamily: 'var(--font-display)' }}>
            Aa
          </div>
          <h3>Newsreader</h3>
          <p>
            Editorial warmth for display headings and introductions. Use regular weight, with an
            occasional italic for emphasis.
          </p>
          <div className={s.fontAlphabet} style={{ fontFamily: 'var(--font-display)' }}>
            ABCDEFGHIJKLMNOPQRSTUVWXYZ
            <br />
            abcdefghijklmnopqrstuvwxyz
            <br />
            0123456789 & @ ? !
          </div>
        </div>
        <div className={s.fontCard}>
          <small>THE EVERYDAY VOICE</small>
          <div className={s.fontSample}>Aa</div>
          <h3>DM Sans</h3>
          <p>
            Quietly capable in forms, navigation, tables, and reports. Use 400 for reading and
            500–600 for labels and hierarchy.
          </p>
          <div className={s.fontAlphabet}>
            ABCDEFGHIJKLMNOPQRSTUVWXYZ
            <br />
            abcdefghijklmnopqrstuvwxyz
            <br />
            0123456789 & @ ? !
          </div>
        </div>
      </div>
      <section className={s.contentSection}>
        <h2>Try the type scale</h2>
        <p className={s.sectionDescription}>
          Edit the sample to see how real content feels across the system. Display sizes adapt down
          on smaller screens.
        </p>
        <Field
          label="Your sample text"
          placeholder="Type something considered…"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
        />
        <div className={s.panel} style={{ marginTop: 20 }}>
          {scale.map(([label, size, font, fallback]) => (
            <div className={s.typeScaleRow} key={label}>
              <span>{label}</span>
              <div
                style={
                  {
                    fontSize: size,
                    fontFamily: font === 'Newsreader' ? 'var(--font-display)' : 'var(--font-sans)',
                    fontWeight: label.startsWith('Heading') ? 500 : 400,
                    '--sample-size': `${size}px`,
                  } as CSSProperties
                }
              >
                {sample || fallback}
              </div>
              <span>
                {size}px / {font}
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className={s.contentSection}>
        <Alert title="Legibility is a field requirement.">
          Keep reading text comfortably spaced. Mobile inputs use at least 16px to avoid unwanted
          browser zoom. Never use display type for inspection findings or form controls.
        </Alert>
      </section>
    </>
  );
}

function Layout() {
  const [motion, setMotion] = useState(false);
  return (
    <>
      <PageHeader
        category="Foundations / 03"
        title="Room to breathe."
        description="A simple 4px rhythm makes space feel intentional. Flexible layouts preserve that rhythm from the inspector’s phone to a wide-screen portal."
      />
      <div className={s.twoColumns}>
        <div className={s.panel}>
          <h2 className={s.subheading}>The spacing scale</h2>
          {[4, 8, 12, 16, 20, 24, 32, 40, 48].map((value) => (
            <div className={s.spacingRow} key={value}>
              <code>--space-{value / 4}</code>
              <span>{value}px</span>
              <div className={s.spacingBar} style={{ width: value * 3 }} />
            </div>
          ))}
        </div>
        <div className={s.stack}>
          <div className={s.panel}>
            <h2 className={s.subheading}>A softer edge</h2>
            <div className={s.row}>
              {[6, 8, 12, 16].map((radius) => (
                <div key={radius} className={s.radiusBox} style={{ borderRadius: radius }}>
                  {radius}px
                </div>
              ))}
            </div>
            <p className={s.smallNote}>
              6–8px for controls. 12px for cards. 16px for larger surfaces.
            </p>
          </div>
          <div className={s.panel}>
            <h2 className={s.subheading}>Elevation, kept quiet</h2>
            <div className={s.row}>
              <div
                className={s.radiusBox}
                style={{
                  background: 'white',
                  borderColor: 'var(--border)',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                Surface
              </div>
              <div
                className={s.radiusBox}
                style={{
                  background: 'white',
                  borderColor: 'var(--border)',
                  boxShadow: 'var(--shadow-float)',
                }}
              >
                Overlay
              </div>
            </div>
            <p className={s.smallNote}>Borders organize. Shadows explain what floats above.</p>
          </div>
        </div>
      </div>
      <section className={s.contentSection}>
        <h2>One system. Every screen.</h2>
        <p className={s.sectionDescription}>
          Breakpoints respond to available space. A field interaction stays usable by touch; a
          portal view makes room for comparison.
        </p>
        <div className={s.layoutExamples}>
          {[
            {
              name: 'Phone',
              width: '320–767px',
              className: s.layoutMobile,
              description: 'Drawer navigation, single-column content, stacked forms.',
            },
            {
              name: 'Tablet',
              width: '768–1023px',
              className: s.layoutTablet,
              description: 'Compact navigation and content-aware two-column grids.',
            },
            {
              name: 'Desktop',
              width: '1024px and up',
              className: '',
              description: 'Persistent sidebar and side-by-side context.',
            },
          ].map((device) => (
            <div className={cx(s.panel, s.layoutCard)} key={device.name}>
              <h3>{device.name}</h3>
              <p>{device.width}</p>
              <div className={cx(s.layoutDiagram, device.className)}>
                {device.name !== 'Phone' && <span />}
                <div>
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <p>{device.description}</p>
            </div>
          ))}
        </div>
      </section>
      <section className={s.contentSection}>
        <div className={s.panel}>
          <h2 className={s.subheading}>Motion with a purpose</h2>
          <p className={s.sectionDescription}>
            160ms transitions give helpful feedback. Movement respects the device’s reduced-motion
            preference.
          </p>
          <div className={s.row}>
            <Button variant="secondary" onClick={() => setMotion((value) => !value)}>
              Try the transition
              <ArrowRight size={15} />
            </Button>
            <div
              className={s.radiusBox}
              style={{
                transform: motion ? 'translateX(24px)' : 'translateX(0)',
                transition: 'transform var(--duration) var(--ease)',
              }}
            >
              <Check size={23} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

const iconSet = {
  House,
  ClipboardCheck,
  Camera,
  Mic,
  Sparkles,
  FileText,
  MapPin,
  Search,
  Plus,
  Check,
  CircleCheck,
  CircleAlert,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  X,
  User,
  Settings,
  Bell,
  Eye,
  Download,
  Upload,
  Image,
  Trash2,
  MoreHorizontal,
  Menu,
  LayoutGrid,
  Layers3,
  Ruler,
  Palette,
  Type,
  Sprout,
  Heart,
  ShieldCheck,
  BookOpen,
  WifiOff,
  MonitorSmartphone,
  AudioLines,
  MousePointer2,
  Sun,
  CheckCheck,
};
function Iconography() {
  const [search, setSearch] = useState('');
  const notify = useToast();
  const icons = Object.entries(iconSet).filter(([name]) =>
    name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        category="Foundations / 04"
        title="Meaning in the details."
        description="Lucide’s simple, rounded strokes feel at home in Satvey. Icons clarify familiar actions and always work alongside accessible labels."
      />
      <div className={s.panel}>
        <div className={s.row} style={{ gap: 28 }}>
          <span className={s.muted}>
            Stroke <strong>1.5–1.75px</strong>
          </span>
          <span className={s.muted}>
            Sizes <strong>16 / 20 / 24px</strong>
          </span>
          <span className={s.muted}>
            Touch area <strong>44 × 44px minimum</strong>
          </span>
        </div>
      </div>
      <div style={{ marginTop: 24 }}>
        <Field
          label="Find an icon"
          leading={<Search size={16} />}
          placeholder="Search house, camera, check…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className={s.iconGrid}>
        {icons.map(([name, Icon]) => (
          <button
            className={s.iconTile}
            key={name}
            onClick={async () => {
              try {
                await copy(`<${name} size={20} strokeWidth={1.75} />`);
                notify({ title: `${name} copied`, description: 'Ready to use with lucide-react.' });
              } catch {
                notify({ title: name, description: `Import ${name} from lucide-react.` });
              }
            }}
            aria-label={`Copy ${name} icon usage`}
          >
            <Icon size={24} strokeWidth={1.65} />
            <span>{name}</span>
          </button>
        ))}
      </div>
      {!icons.length && (
        <div className={s.emptyResults}>No icons match “{search}”. Try a different name.</div>
      )}
      <section className={s.contentSection}>
        <Alert title="A symbol should never be a guessing game.">
          Give every icon-only button a descriptive label. Pair status icons with text, and keep
          decorative icons out of the accessibility tree.
        </Alert>
      </section>
    </>
  );
}

function Principles() {
  return (
    <>
      <PageHeader
        category="The Satvey philosophy"
        title="Considered. In every detail."
        description="Property inspections involve a lot of information and real human judgment. Our design system makes room for both, with less noise and a little more care."
      />
      <div className={s.principleCards}>
        {[
          {
            Icon: Sprout,
            title: 'Calm by nature.',
            text: 'Warm surfaces, quiet structure, and generous space keep attention on the property. Every color, line, and shadow should earn its place.',
            note: 'Start with less. Add what helps.',
          },
          {
            Icon: Layers3,
            title: 'Clear by design.',
            text: 'Consistent patterns make the next step feel familiar. Prioritize readable findings, obvious actions, and feedback that explains what happened.',
            note: 'Make confidence the default.',
          },
          {
            Icon: Heart,
            title: 'Human at heart.',
            text: 'AI can identify a possibility. An inspector brings context and makes the call. Respect their expertise, their attention, and the way they work.',
            note: 'AI suggests. People decide.',
          },
        ].map(({ Icon, title, text, note }) => (
          <div className={cx(s.panel, s.principleCard)} key={title}>
            <Icon size={29} strokeWidth={1.4} />
            <h2>{title}</h2>
            <p>{text}</p>
            <strong>{note}</strong>
          </div>
        ))}
      </div>
      <section className={s.contentSection}>
        <h2>Designed for the work.</h2>
        <div className={s.twoColumns}>
          <div className={s.panel}>
            <h3 className={s.subheading}>In the field</h3>
            <p className={s.sectionDescription}>
              One hand on a phone, moving between rooms. Touch-sized controls, legible text, and a
              single clear next action keep the inspector moving.
            </p>
            <Link className={s.textLink} to="/design-system/patterns/inspection">
              See inspection patterns
              <ArrowRight size={14} />
            </Link>
          </div>
          <div className={s.panel}>
            <h3 className={s.subheading}>Back at the desk</h3>
            <p className={s.sectionDescription}>
              More space to compare, review, and compose. The same foundations scale into structured
              tables and contextual panels.
            </p>
            <Link className={s.textLink} to="/design-system/components/data-display">
              Explore data display
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

export function Foundations() {
  const { section } = useParams();
  if (section === 'colors') return <Colors />;
  if (section === 'typography') return <Typography />;
  if (section === 'layout') return <Layout />;
  if (section === 'iconography') return <Iconography />;
  if (section === 'principles') return <Principles />;
  return (
    <>
      <PageHeader
        category="Foundations"
        title="A fresh starting point."
        description="Choose a foundation from the navigation to explore the system."
      />
      <Link to="/design-system/foundations/colors" className={s.solidLink}>
        Explore colors
        <ArrowRight size={14} />
      </Link>
    </>
  );
}
