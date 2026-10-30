import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  Heart,
  Layers3,
  Mic,
  MoveUpRight,
  Sparkles,
  Sprout,
} from 'lucide-react';
import { Badge } from '../components/ui';
import {
  ButtonExamples,
  FormExamples,
  PropertyCard,
  StatusExamples,
  Waveform,
} from '../components/examples';
import { foundationCards } from '../navigation';
import s from './Overview.module.css';

const chapters = [
  { number: '01', title: 'Foundations', description: 'Set the language', anchor: 'foundations' },
  {
    number: '02',
    title: 'Components',
    description: 'Build with consistency',
    anchor: 'components',
  },
  { number: '03', title: 'Patterns', description: 'See it in context', anchor: 'patterns' },
];

export function Overview() {
  return (
    <>
      <div className={s.introLine}>
        <span className={s.eyebrow}>THE SATVEY DESIGN SYSTEM</span>
        <span className={s.version}>
          <i />
          Version 1.0
        </span>
      </div>
      <section className={s.hero} aria-labelledby="overview-title">
        <div className={s.heroCopy}>
          <h1 id="overview-title">
            Clarity comes
            <br />
            <em>naturally.</em>
          </h1>
          <p>
            A calmer way to design for the places we live.
            <br className={s.wideBreak} /> Considered components for clear, confident inspections.
          </p>
          <div className={s.heroActions}>
            <Link className={s.primaryLink} to="/design-system/components/buttons">
              Explore the components
              <ArrowRight size={17} />
            </Link>
            <Link className={s.secondaryLink} to="/design-system/foundations/principles">
              Our approach
              <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className={s.heroFootnote}>
            <span className={s.footnoteLine} />
            One shared language. Every screen.
          </div>
        </div>
        <div className={s.heroComposition}>
          <div className={s.photoFrame}>
            <img
              src="/images/living-room.jpg"
              alt="A sunlit living room with warm timber, natural fabrics, and leafy plants"
              width="1100"
              height="825"
              fetchPriority="high"
            />
            <span className={s.photoLabel}>Spaces worth caring for.</span>
          </div>
          <div
            className={s.paletteRail}
            role="img"
            aria-label="Satvey materials palette in olive, sand, and clay"
          >
            <i />
            <i />
            <i />
            <span>Earth. Light. Balance.</span>
          </div>
          <div className={s.floatingFinding}>
            <div className={s.findingMeta}>
              <span className={s.findingIcon}>
                <Sparkles size={18} />
              </span>
              <span>AN OBSERVATION</span>
              <Badge tone="warning" dot>
                For review
              </Badge>
            </div>
            <h2>
              Every detail deserves
              <br />a considered decision.
            </h2>
            <div className={s.findingBottom}>
              <span>
                Living room <i /> Surface condition
              </span>
              <Link to="/design-system/patterns/inspection" aria-label="Review sample observation">
                <ArrowUpRight size={20} />
              </Link>
            </div>
          </div>
          <span className={s.compositionIndex}>SATVEY / FIELD NOTES — 001</span>
        </div>
      </section>
      <nav className={s.chapterNav} aria-label="On this page">
        {chapters.map((chapter) => (
          <a href={`#${chapter.anchor}`} key={chapter.number}>
            <span className={s.chapterNumber}>{chapter.number}</span>
            <span>
              <strong>{chapter.title}</strong>
              <small>{chapter.description}</small>
            </span>
            <ArrowRight size={17} />
          </a>
        ))}
      </nav>
      <section className={s.section} id="foundations" aria-labelledby="foundations-title">
        <div className={s.sectionHeading}>
          <div>
            <span className={s.eyebrow}>01 / THE FOUNDATIONS</span>
            <h2 id="foundations-title">A language, grounded in nature.</h2>
            <p>Warm materials. Clear structure. Room to breathe.</p>
          </div>
          <Link to="/design-system/foundations/colors" className={s.sectionLink}>
            View foundations
            <ArrowRight size={16} />
          </Link>
        </div>
        <div className={s.foundationsGrid}>
          {foundationCards.map(({ label, path, text }, index) => (
            <Link key={path} className={s.foundationTile} to={path}>
              <div className={`${s.foundationArt} ${s[`art${index}`]}`} aria-hidden="true">
                {index === 0 ? (
                  <div className={s.colorStudy}>
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                ) : index === 1 ? (
                  <div className={s.typeStudy}>
                    Aa<span>abc.</span>
                  </div>
                ) : index === 2 ? (
                  <div className={s.gridStudy}>
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                ) : (
                  <div className={s.iconStudy}>
                    <Sprout />
                    <Heart />
                    <Layers3 />
                    <Sparkles />
                  </div>
                )}
              </div>
              <div className={s.foundationLabel}>
                <span>
                  <strong>{label}</strong>
                  <small>{text}</small>
                </span>
                <ArrowUpRight size={18} />
              </div>
            </Link>
          ))}
        </div>
      </section>
      <section className={s.section} id="components" aria-labelledby="components-title">
        <div className={s.sectionHeading}>
          <div>
            <span className={s.eyebrow}>02 / THE BUILDING BLOCKS</span>
            <h2 id="components-title">Familiar parts. Thoughtful details.</h2>
            <p>Try the components. Feel how the system works.</p>
          </div>
          <Link to="/design-system/components/buttons" className={s.sectionLink}>
            Browse components
            <ArrowRight size={16} />
          </Link>
        </div>
        <div className={s.componentGrid}>
          <article className={s.specimen}>
            <div className={s.specimenHeader}>
              <div>
                <h3>Make the next step clear.</h3>
                <p>Buttons & actions</p>
              </div>
              <Link to="/design-system/components/buttons" aria-label="Explore buttons and actions">
                <ArrowUpRight size={20} />
              </Link>
            </div>
            <div className={s.specimenContent}>
              <ButtonExamples />
            </div>
            <div className={s.specimenFooter}>
              <span className={s.specimenDot} />
              Primary, secondary, and quiet actions.
            </div>
          </article>
          <article className={s.specimen}>
            <div className={s.specimenHeader}>
              <div>
                <h3>Less friction. More flow.</h3>
                <p>Inputs & controls</p>
              </div>
              <Link to="/design-system/components/forms" aria-label="Explore inputs and controls">
                <ArrowUpRight size={20} />
              </Link>
            </div>
            <div className={s.specimenContent}>
              <FormExamples />
            </div>
            <div className={s.specimenFooter}>
              <span className={s.specimenDot} />
              Clear labels. Comfortable touch targets.
            </div>
          </article>
          <article className={s.specimen}>
            <div className={s.specimenHeader}>
              <div>
                <h3>A little reassurance.</h3>
                <p>Status & feedback</p>
              </div>
              <Link
                to="/design-system/components/feedback"
                aria-label="Explore status and feedback"
              >
                <ArrowUpRight size={20} />
              </Link>
            </div>
            <div className={s.specimenContent}>
              <StatusExamples />
              <div className={s.successNote}>
                <span>
                  <Check size={18} />
                </span>
                <div>
                  <strong>Observation saved</strong>
                  <p>A clear signal that you can move forward.</p>
                </div>
              </div>
            </div>
            <div className={s.specimenFooter}>
              <span className={s.specimenDot} />
              Meaning through words, icons, and color.
            </div>
          </article>
          <article className={`${s.specimen} ${s.voiceSpecimen}`}>
            <div className={s.specimenHeader}>
              <div>
                <h3>Your expertise, supported.</h3>
                <p>AI & voice patterns</p>
              </div>
              <Link
                to="/design-system/patterns/inspection"
                aria-label="Explore AI and voice patterns"
              >
                <ArrowUpRight size={20} />
              </Link>
            </div>
            <div className={s.specimenContent}>
              <div className={s.assistance}>
                <span className={s.assistanceIcon}>
                  <Sparkles size={22} />
                </span>
                <div>
                  <strong>AI suggests. You decide.</strong>
                  <p>Human judgment stays at the heart.</p>
                </div>
              </div>
              <Link className={s.voiceStrip} to="/design-system/patterns/inspection">
                <Mic size={18} />
                <Waveform />
                <span>00:24</span>
                <span className="sr-only">Explore simulated dictation</span>
              </Link>
            </div>
            <div className={s.specimenFooter}>
              <span className={s.specimenDot} />A preview of observation and review.
            </div>
          </article>
        </div>
      </section>
      <section className={s.patternFeature} id="patterns" aria-labelledby="patterns-title">
        <div className={s.patternCopy}>
          <span className={s.eyebrow}>03 / THE SYSTEM IN PRACTICE</span>
          <h2 id="patterns-title">
            Good tools.
            <br />
            <em>Better judgment.</em>
          </h2>
          <p>
            From a first impression to a considered finding. See the system come together in an
            inspection mockup.
          </p>
          <Link className={s.inverseLink} to="/design-system/patterns/inspection">
            Explore the inspection pattern
            <ArrowRight size={17} />
          </Link>
          <div className={s.patternNote}>
            <CheckCheck size={18} />
            Made for phone, tablet, and desktop.
          </div>
        </div>
        <div className={s.patternSample}>
          <PropertyCard compact />
          <span className={s.sampleCaption}>ILLUSTRATIVE PROPERTY / COMPONENT PATTERN</span>
        </div>
      </section>
      <div className={s.principles}>
        {[
          { Icon: Sprout, title: 'Calm by nature', text: 'Make space for what matters.' },
          {
            Icon: Layers3,
            title: 'Consistent by design',
            text: 'Familiar, from the first interaction.',
          },
          { Icon: Heart, title: 'Human at heart', text: 'Built around an inspector’s expertise.' },
        ].map(({ Icon, title, text }) => (
          <Link to="/design-system/foundations/principles" key={title}>
            <Icon size={22} strokeWidth={1.5} />
            <div>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
            <MoveUpRight size={16} />
          </Link>
        ))}
      </div>
    </>
  );
}
