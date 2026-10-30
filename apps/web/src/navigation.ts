import {
  BookOpen,
  CheckCheck,
  Columns3,
  FormInput,
  Grid2X2,
  House,
  Layers3,
  LayoutGrid,
  MousePointer2,
  Palette,
  Ruler,
  Shapes,
  Type,
} from 'lucide-react';

export const navigation = [
  {
    heading: '',
    items: [
      {
        label: 'Overview',
        path: '/design-system',
        icon: LayoutGrid,
        description: 'Meet the Satvey design system',
      },
    ],
  },
  {
    heading: 'Foundations',
    items: [
      {
        label: 'Colors',
        path: '/design-system/foundations/colors',
        icon: Palette,
        description: 'Natural colors, semantic tokens, and contrast',
      },
      {
        label: 'Typography',
        path: '/design-system/foundations/typography',
        icon: Type,
        description: 'Type scales and font pairings',
      },
      {
        label: 'Spacing & layout',
        path: '/design-system/foundations/layout',
        icon: Ruler,
        description: 'Spacing, grids, elevation, and motion',
      },
      {
        label: 'Iconography',
        path: '/design-system/foundations/iconography',
        icon: Shapes,
        description: 'A consistent visual language with Lucide icons',
      },
    ],
  },
  {
    heading: 'Components',
    items: [
      {
        label: 'Buttons',
        path: '/design-system/components/buttons',
        icon: MousePointer2,
        description: 'Actions, sizes, loading, and disabled states',
      },
      {
        label: 'Form controls',
        path: '/design-system/components/forms',
        icon: FormInput,
        description: 'Inputs, selects, checkboxes, switches, and sliders',
      },
      {
        label: 'Data display',
        path: '/design-system/components/data-display',
        icon: Columns3,
        description: 'Cards, tables, badges, avatars, and progress',
      },
      {
        label: 'Feedback',
        path: '/design-system/components/feedback',
        icon: CheckCheck,
        description: 'Alerts, toasts, loading, and empty states',
      },
      {
        label: 'Overlays',
        path: '/design-system/components/overlays',
        icon: Layers3,
        description: 'Dialogs, menus, popovers, and tooltips',
      },
    ],
  },
  {
    heading: 'Patterns',
    items: [
      {
        label: 'Inspector application',
        path: '/app',
        icon: House,
        description: 'Open the Dutch inspection journey prototype',
      },
      {
        label: 'Property inspection',
        path: '/design-system/patterns/inspection',
        icon: House,
        description: 'An inspection mockup using the design system',
      },
    ],
  },
];
export const allPages = [
  ...navigation.flatMap((group) => group.items),
  {
    label: 'Design principles',
    path: '/design-system/foundations/principles',
    icon: BookOpen,
    description: 'Calm, clear, and considered',
  },
];
export const foundationCards = [
  {
    label: 'Colors',
    icon: Palette,
    path: '/design-system/foundations/colors',
    text: 'Rooted in nature.',
  },
  {
    label: 'Typography',
    icon: Type,
    path: '/design-system/foundations/typography',
    text: 'Clarity with character.',
  },
  {
    label: 'Spacing & layout',
    icon: Grid2X2,
    path: '/design-system/foundations/layout',
    text: 'Room to breathe.',
  },
  {
    label: 'Iconography',
    icon: Shapes,
    path: '/design-system/foundations/iconography',
    text: 'Small, meaningful details.',
  },
];
export const componentCount = 32;
