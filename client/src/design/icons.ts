import {
  ArrowLeftIcon,
  ArrowUpIcon,
  ChatCircleIcon,
  CheckIcon,
  DesktopIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UserCircleIcon,
  XIcon,
} from '@phosphor-icons/react';

/** Screens reference semantic roles here; default weight is regular, 24 px. */
export const icons = {
  back: ArrowLeftIcon,
  send: ArrowUpIcon,
  chat: ChatCircleIcon,
  approve: CheckIcon,
  deny: XIcon,
  close: XIcon,
  device: DesktopIcon,
  settings: GearSixIcon,
  search: MagnifyingGlassIcon,
  add: PlusIcon,
  avatar: UserCircleIcon,
} as const;
