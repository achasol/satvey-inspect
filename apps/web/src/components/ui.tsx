import { createContext, useContext, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import {
  Avatar as RAvatar,
  Checkbox as RCheckbox,
  Dialog as RDialog,
  Progress as RProgress,
  Select as RSelect,
  Switch as RSwitch,
  Toast,
  Tooltip as RTooltip,
} from 'radix-ui';
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Info,
  LoaderCircle,
  Sparkles,
  X,
} from 'lucide-react';
import s from './ui.module.css';

export function cx(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(' ');
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
};
export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cx(s.button, s[variant], s[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <LoaderCircle size={16} className={s.spin} aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, ...props }: ButtonProps & { label: string }) {
  return (
    <Button
      variant="ghost"
      {...props}
      className={cx(s.iconButton, props.className)}
      aria-label={label}
    >
      {children}
    </Button>
  );
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'ai';
export function Badge({
  children,
  tone = 'neutral',
  dot,
  icon,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  icon?: boolean;
}) {
  const Icon = {
    neutral: Info,
    success: CircleCheck,
    warning: CircleAlert,
    danger: CircleAlert,
    info: Info,
    ai: Sparkles,
  }[tone];
  return (
    <span className={cx(s.badge, s[`badge_${tone}`])}>
      {dot && <span className={s.dot} />}
      {icon && <Icon size={12} aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  className,
  leading,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
  leading?: ReactNode;
}) {
  const id = useId();
  const inputId = props.id ?? id;
  return (
    <div className={cx(s.field, className)}>
      <label htmlFor={inputId}>
        {label}
        {props.required && (
          <span className={s.required} aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <div className={s.inputWrap}>
        {leading && <span className={s.leading}>{leading}</span>}
        <input
          {...props}
          id={inputId}
          className={cx(s.input, leading ? s.withLeading : undefined)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${inputId}-help` : undefined}
        />
      </div>
      {(error || hint) && (
        <span id={`${inputId}-help`} className={cx(s.hint, error ? s.error : undefined)}>
          {error || hint}
        </span>
      )}
    </div>
  );
}

export function Select({
  label,
  value,
  onValueChange,
  items,
  placeholder = 'Select an option',
  disabled,
}: {
  label: string;
  value?: string;
  onValueChange?: (value: string) => void;
  items: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      <RSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
        <RSelect.Trigger id={id} className={s.select}>
          <RSelect.Value placeholder={placeholder} />
          <RSelect.Icon>
            <ChevronDown size={16} />
          </RSelect.Icon>
        </RSelect.Trigger>
        <RSelect.Portal>
          <RSelect.Content className={s.selectContent} position="popper" sideOffset={6}>
            <RSelect.Viewport>
              {items.map((item) => (
                <RSelect.Item key={item} value={item} className={s.selectItem}>
                  <RSelect.ItemText>{item}</RSelect.ItemText>
                  <RSelect.ItemIndicator>
                    <Check size={15} />
                  </RSelect.ItemIndicator>
                </RSelect.Item>
              ))}
            </RSelect.Viewport>
          </RSelect.Content>
        </RSelect.Portal>
      </RSelect.Root>
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={s.checkField}>
      <RCheckbox.Root
        id={id}
        className={s.checkbox}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange?.(v === true)}
        disabled={disabled}
      >
        <RCheckbox.Indicator className={s.checkboxIndicator}>
          <Check size={13} strokeWidth={2.5} />
        </RCheckbox.Indicator>
      </RCheckbox.Root>
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

export function Switch({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  checked?: boolean;
  onCheckedChange?: (value: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={s.switchField}>
      <RSwitch.Root
        id={id}
        className={s.switch}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      >
        <RSwitch.Thumb className={s.switchThumb} />
      </RSwitch.Root>
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

export function Progress({
  value,
  label = 'Inspection progress',
}: {
  value: number;
  label?: string;
}) {
  return (
    <RProgress.Root className={s.progress} value={value} aria-label={label}>
      <RProgress.Indicator
        className={s.progressIndicator}
        style={{ transform: `translateX(-${100 - value}%)` }}
      />
    </RProgress.Root>
  );
}

export function Avatar({
  initials = 'EL',
  label = 'Emma Lewis',
}: {
  initials?: string;
  label?: string;
}) {
  return (
    <RAvatar.Root className={s.avatar} aria-label={label}>
      <RAvatar.Fallback>{initials}</RAvatar.Fallback>
    </RAvatar.Root>
  );
}

export function Tooltip({ children, text }: { children: ReactNode; text: string }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className={s.tooltip} sideOffset={8}>
          {text}
          <RTooltip.Arrow className={s.tooltipArrow} />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export function Dialog({
  trigger,
  title,
  description,
  children,
  open,
  onOpenChange,
  wide,
  fullOnMobile = true,
  touch,
  closeLabel = 'Close dialog',
}: {
  trigger?: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  wide?: boolean;
  fullOnMobile?: boolean;
  touch?: boolean;
  closeLabel?: string;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RDialog.Trigger asChild>{trigger}</RDialog.Trigger>}
      <RDialog.Portal>
        <RDialog.Overlay className={s.overlay} />
        <RDialog.Content
          className={cx(
            s.dialog,
            wide && s.wideDialog,
            fullOnMobile && s.fullOnMobile,
            touch && s.touchDialog,
          )}
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            if (!trigger && returnFocus.current?.isConnected) {
              event.preventDefault();
              returnFocus.current.focus();
            }
          }}
        >
          <div className={s.dialogHeader}>
            <div>
              <RDialog.Title className={s.dialogTitle}>{title}</RDialog.Title>
              <RDialog.Description className={cx(s.dialogDescription, !description && 'sr-only')}>
                {description || 'Interactive component preview.'}
              </RDialog.Description>
            </div>
            <RDialog.Close asChild>
              <IconButton label={closeLabel}>
                <X size={18} />
              </IconButton>
            </RDialog.Close>
          </div>
          <div className={s.dialogBody}>{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

type Notification = { title: string; description?: string };
const ToastContext = createContext<(notification: Notification) => void>(() => {});
export function useToast() {
  return useContext(ToastContext);
}
export function UIProvider({
  children,
  locale = 'en',
}: {
  children: ReactNode;
  locale?: 'en' | 'nl';
}) {
  const [notification, setNotification] = useState<Notification | null>(null);
  const [open, setOpen] = useState(false);
  const notify = (value: Notification) => {
    setNotification(value);
    setOpen(true);
  };
  return (
    <ToastContext.Provider value={notify}>
      <RTooltip.Provider delayDuration={300}>
        <Toast.Provider swipeDirection="right" duration={4000}>
          {children}
          <Toast.Root className={s.toast} open={open} onOpenChange={setOpen}>
            <CircleCheck size={21} className={s.toastIcon} />
            <div>
              <Toast.Title className={s.toastTitle}>{notification?.title}</Toast.Title>
              {notification?.description && (
                <Toast.Description className={s.toastDescription}>
                  {notification.description}
                </Toast.Description>
              )}
            </div>
            <Toast.Close asChild>
              <IconButton label={locale === 'nl' ? 'Melding sluiten' : 'Dismiss notification'}>
                <X size={16} />
              </IconButton>
            </Toast.Close>
          </Toast.Root>
          <Toast.Viewport className={s.toastViewport} />
        </Toast.Provider>
      </RTooltip.Provider>
    </ToastContext.Provider>
  );
}

export function Alert({
  title,
  children,
  tone = 'info',
}: {
  title: string;
  children: ReactNode;
  tone?: 'info' | 'success' | 'warning' | 'danger';
}) {
  const Icon = tone === 'success' ? CircleCheck : tone === 'info' ? Info : CircleAlert;
  return (
    <div className={cx(s.alert, s[`badge_${tone}`])} role={tone === 'danger' ? 'alert' : 'note'}>
      <Icon size={19} />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(s.card, className)}>{children}</div>;
}

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect width="40" height="40" rx="11" fill="currentColor" />
      <path
        d="M11 28V17l9-7 9 7v11M16 28V18l4-3 4 3v10"
        stroke="var(--canvas)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
