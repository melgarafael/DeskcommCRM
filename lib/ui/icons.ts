/**
 * Canonical icon map. Toda feature importa daqui — não direto de @phosphor-icons/react.
 * ADR-05 (Spec 09 §12). Permite swap futuro sem big-bang refactor.
 *
 * Re-exporting from `@phosphor-icons/react/dist/ssr` so Server Components can
 * render icons without forcing the entire CSR React-context module client-side.
 * Client Components still get fully interactive icons (size/weight/color).
 */

export {
  // navigation (inbox icon = Tray in Phosphor)
  Tray as Inbox,
  Kanban,
  Users,
  UsersThree,
  Storefront,
  Robot,
  ShieldCheck,
  Gear,
  House,
  // actions
  PaperPlaneTilt,
  Check,
  Checks,
  X,
  Plus,
  Trash,
  PencilSimple,
  MagnifyingGlass,
  // feedback
  CheckCircle,
  WarningOctagon,
  Info,
  CircleNotch,
  // theme
  Sun,
  Moon,
  MonitorPlay,
  // conversation
  ChatCircle,
  Phone,
  Paperclip,
  // misc
  DotsThree,
  CaretDown,
  CaretDoubleLeft,
  CaretDoubleRight,
  ArrowRight,
  SignOut,
} from "@phosphor-icons/react/dist/ssr";
