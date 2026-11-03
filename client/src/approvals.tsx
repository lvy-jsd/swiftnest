import { useState } from "react";
import { translateMessage } from "@swiftnest/api";
import type { ApprovalAnswer } from "@swiftnest/api";
import type { ChatRow } from "./chat";
import { useConnection } from "./connection";
import { useI18n } from "./i18n";
import { Button } from "./components/Button";

/** DSH risk-gate approvals use the chat interaction channel. */
export function ApprovalCard({
  request,
  onAnswered,
}: {
  request: Extract<ChatRow, { kind: "approval" }>;
  onAnswered: (requestId: string) => void;
}) {
  const { t, locale } = useI18n();
  const { store, status } = useConnection();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function answer(value: ApprovalAnswer) {
    if (!store.client || busy || request.settled) return;
    setBusy(true);
    setFailed(false);
    try {
      await store.client.answerApproval(request.requestId, value);
      onAnswered(request.requestId);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="event-card" aria-label={t("toolApproval")}>
      <strong>{t("toolApproval")}</strong>
      <p>{request.toolName}</p>
      {request.reason && <p>{translateMessage(request.reason, locale)}</p>}
      {request.settled ? (
        <p>{t("toolApprovalSettled")}</p>
      ) : (
        <ApprovalButtons disabled={busy || status !== "connected"} onAnswer={answer} />
      )}
      {failed && <p role="alert">{t("toolApprovalFailed")}</p>}
    </article>
  );
}

function ApprovalButtons({
  disabled,
  onAnswer,
}: {
  disabled: boolean;
  onAnswer: (value: ApprovalAnswer) => Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <div className="device-actions">
      <Button disabled={disabled} onClick={() => void onAnswer("rejected")}>
        {t("deny")}
      </Button>
      <Button variant="primary" disabled={disabled} onClick={() => void onAnswer("allowed-once")}>
        {t("approve")}
      </Button>
    </div>
  );
}
