import type { FormEventHandler, ReactNode } from "react";
import { useI18n } from "../i18n";
import { icons } from "../design/icons";
import { Button } from "./Button";
import { PageHeader } from "./PageHeader";
import type { PageHeaderProps } from "./PageHeader";
import { Sheet } from "./Sheet";
import { VirtualList } from "./VirtualList";

type PageProps = Omit<PageHeaderProps, "large" | "children"> & { children: ReactNode };
export function HubPage({ children, ...header }: PageProps) {
  return <section className="page page--hub"><PageHeader {...header} large /><div className="page__body card-groups">{children}</div></section>;
}
export function DetailPage({ children, ...header }: PageProps) {
  return <section className="page page--detail"><PageHeader {...header} /><div className="page__content">{children}</div></section>;
}
export function ListPage<T>({ title, onBack, query, onQueryChange, items, itemKey, renderItem }: { title: string; onBack: () => void; query: string; onQueryChange: (value: string) => void; items: readonly T[]; itemKey: (item: T) => string; renderItem: (item: T) => ReactNode }) {
  const { t } = useI18n();
  const Search = icons.search;
  return <section className="page page--list"><PageHeader title={title} onBack={onBack}><label className="search-field"><Search size={24} aria-hidden="true" /><input type="search" value={query} onChange={event => onQueryChange(event.target.value)} aria-label={t("search")} placeholder={t("search")} /></label></PageHeader><VirtualList items={items} itemKey={itemKey} renderItem={renderItem} label={title} className="page__body" /></section>;
}
export function FormPage({ children, onSave, saveLabel, saveDisabled, ...header }: Omit<PageProps, "action"> & { onSave: FormEventHandler<HTMLFormElement>; saveLabel?: string; saveDisabled?: boolean }) {
  const { t } = useI18n();
  return <form className="page page--form" onSubmit={onSave}><PageHeader {...header} action={<Button type="submit" variant="primary" disabled={saveDisabled}>{saveLabel ?? t("save")}</Button>} /><div className="page__body field-groups">{children}</div></form>;
}
export function SheetPage(props: Parameters<typeof Sheet>[0]) {
  return <Sheet {...props} />;
}
