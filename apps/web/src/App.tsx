import { lazy, Suspense, useEffect, useState } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Command,
  ExternalLink,
  Menu,
  Search,
  Sprout,
  Sun,
  X,
} from 'lucide-react';
import { allPages, navigation } from './navigation';
import { BrandMark, Dialog, IconButton, UIProvider, cx } from './components/ui';
import { Overview } from './pages/Overview';
import s from './App.module.css';
import { PublicInformation } from './workspace/PublicInformation';
import { Workspace } from './workspace/Workspace';

const Foundations = lazy(async () => ({
  default: (await import('./pages/Foundations')).Foundations,
}));
const ComponentsPage = lazy(async () => ({
  default: (await import('./pages/Components')).ComponentsPage,
}));
const InspectionPage = lazy(async () => ({
  default: (await import('./pages/Inspection')).InspectionPage,
}));

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <Link
        to="/design-system"
        onClick={onNavigate}
        className={s.brand}
        aria-label="Satvey design system home"
      >
        <BrandMark size={33} />
        <span>
          satvey<span className={s.brandDot}>.</span>
        </span>
      </Link>
      <div className={s.brandCaption}>
        DESIGN SYSTEM <span>1.0</span>
      </div>
      <nav className={s.navigation} aria-label="Main navigation">
        {navigation.map((group) => (
          <div className={s.navGroup} key={group.heading}>
            {group.heading && <div className={s.navHeading}>{group.heading}</div>}
            {group.items.map(({ label, path, icon: Icon }) => (
              <NavLink
                key={path}
                to={path}
                end
                onClick={onNavigate}
                className={({ isActive }) => cx(s.navLink, isActive && s.navActive)}
              >
                <Icon size={17} strokeWidth={1.65} />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className={s.sidebarBottom}>
        <Link
          className={s.principlesLink}
          to="/design-system/foundations/principles"
          onClick={onNavigate}
        >
          <BookOpen size={16} />
          Design principles
          <ArrowUpRight size={14} />
        </Link>
        <div className={s.sidebarNote}>
          <Sprout size={20} strokeWidth={1.4} />
          <p>
            A considered foundation.
            <br />
            <span>For everything you build.</span>
          </p>
        </div>
        <a
          href="https://www.radix-ui.com/primitives"
          target="_blank"
          rel="noreferrer"
          className={s.radixLink}
        >
          Built on Radix UI
          <ExternalLink size={12} />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
    </>
  );
}

function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const results = allPages.filter((page) =>
    `${page.label} ${page.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Find your component"
      description="Search foundations, components, and patterns."
    >
      <div className={s.searchInput}>
        <Search size={18} />
        <input
          autoFocus
          aria-label="Search the design system"
          placeholder="Try buttons, colors, or dialogs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className={s.searchResults}>
        {results.length ? (
          results.map(({ path, label, icon: Icon, description }) => (
            <button
              key={path}
              className={s.searchResult}
              onClick={() => {
                navigate(path);
                onOpenChange(false);
                setQuery('');
              }}
            >
              <Icon size={18} />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              <ArrowDownLeft size={15} />
            </button>
          ))
        ) : (
          <p className={s.noResults}>No matches for “{query}”. Try another component name.</p>
        )}
      </div>
      <div className={s.searchHint}>
        Use Tab to navigate <span>Esc to close</span>
      </div>
    </Dialog>
  );
}

function AppContent() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const currentPage = allPages.find((page) => page.path === location.pathname);
  const category = location.pathname.startsWith('/foundations')
    ? 'Foundations'
    : location.pathname.startsWith('/components')
      ? 'Components'
      : location.pathname.startsWith('/patterns')
        ? 'Patterns'
        : 'Design system';
  useEffect(() => {
    document.documentElement.lang = 'en';
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.title = `${currentPage?.label ?? 'Page not found'} · Satvey design system`;
  }, [location.pathname, currentPage?.label]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);
  return (
    <div className={s.app}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className={s.sidebar}>
        <SidebarContent />
      </aside>
      <div className={s.workspace}>
        <header className={s.header}>
          <div className={s.headerStart}>
            <RDialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <RDialog.Trigger asChild>
                <IconButton label="Open navigation" className={s.mobileMenu}>
                  <Menu size={21} />
                </IconButton>
              </RDialog.Trigger>
              <RDialog.Portal>
                <RDialog.Overlay className={s.drawerOverlay} />
                <RDialog.Content className={s.drawer} aria-describedby={undefined}>
                  <RDialog.Title className="sr-only">Navigation</RDialog.Title>
                  <RDialog.Close asChild>
                    <IconButton label="Close navigation" className={s.drawerClose}>
                      <X size={19} />
                    </IconButton>
                  </RDialog.Close>
                  <SidebarContent onNavigate={() => setMenuOpen(false)} />
                </RDialog.Content>
              </RDialog.Portal>
            </RDialog.Root>
            <Link to="/design-system" className={s.mobileBrand} aria-label="Satvey home">
              satvey.
            </Link>
            <div className={s.breadcrumb}>
              <span>{category}</span>
              <ChevronRight size={13} />
              <strong>{currentPage?.label ?? 'Not found'}</strong>
            </div>
          </div>
          <div className={s.headerActions}>
            <button className={s.searchTrigger} onClick={() => setSearchOpen(true)}>
              <Search size={15} />
              <span className="sr-only">Search the design system</span>
              <span className={s.searchText}>Search anything…</span>
              <kbd aria-hidden="true">
                <Command size={10} /> K
              </kbd>
            </button>
            <span className={s.themeLabel}>
              <Sun size={15} />
              <span>Light</span>
            </span>
            <Link
              className={s.previewLink}
              to="/design-system/patterns/inspection"
              aria-label="Inspection preview"
            >
              <span className={s.previewLabel}>Inspection preview</span>
              <ArrowUpRight size={15} />
            </Link>
          </div>
        </header>
        <main id="main-content" className={s.main} tabIndex={-1}>
          <Suspense
            fallback={
              <div className={s.routeLoading} role="status">
                Finding your place…
              </div>
            }
          >
            <Routes>
              <Route path="/design-system" element={<Overview />} />
              <Route path="/design-system/foundations/:section" element={<Foundations />} />
              <Route path="/design-system/components/:section" element={<ComponentsPage />} />
              <Route path="/design-system/patterns/inspection" element={<InspectionPage />} />
              <Route
                path="*"
                element={
                  <div className={s.notFound}>
                    <Sprout size={40} />
                    <h1>A little off the path.</h1>
                    <p>That page isn’t part of this system.</p>
                    <Link to="/design-system" className={s.homeLink}>
                      Back to overview
                    </Link>
                  </div>
                }
              />
            </Routes>
          </Suspense>
        </main>
        <footer className={s.footer}>
          <span>
            <BrandMark size={17} />
            Considered by design. Built for confidence.
          </span>
          <span>
            Satvey design system <span className={s.footerDot}>·</span> v1.0
          </span>
        </footer>
      </div>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

export function App() {
  const { pathname } = useLocation();
  if (!pathname.startsWith('/design-system')) {
    return (
      <UIProvider locale="nl">
        <Suspense fallback={<p role="status">Satvey laden…</p>}>
          {['/support', '/privacy', '/account-deletion'].includes(pathname) ? (
            <PublicInformation />
          ) : (
            <Workspace />
          )}
        </Suspense>
      </UIProvider>
    );
  }
  return (
    <UIProvider>
      <AppContent />
    </UIProvider>
  );
}
