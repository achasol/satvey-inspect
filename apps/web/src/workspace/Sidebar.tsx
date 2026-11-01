import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import s from './workspace.module.css';

export function Sidebar({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false),
    location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.search]);
  return (
    <>
      <aside className={`${s.sidebar} ${s.desktopSidebar}`}>{children}</aside>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <header className={s.mobileHeader}>
          <Link to="/app" aria-label="Satvey inspecties">
            <strong>satvey.</strong>
          </Link>
          <Dialog.Trigger className={s.menuTrigger} aria-label="Navigatie openen">
            <Menu size={22} /> Menu
          </Dialog.Trigger>
        </header>
        <Dialog.Portal>
          <Dialog.Overlay className={s.drawerBackdrop} />
          <Dialog.Content className={s.drawer}>
            <Dialog.Title className="sr-only">Navigatie</Dialog.Title>
            <Dialog.Description className="sr-only">
              Kies een onderdeel van Satvey Inspect.
            </Dialog.Description>
            <Dialog.Close className={s.drawerClose} aria-label="Navigatie sluiten">
              <X size={22} />
            </Dialog.Close>
            {children}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
