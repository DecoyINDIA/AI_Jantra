import { Check, Send, X } from "lucide-react";
import { memo, useState } from "react";
import type { PendingInteractionView } from "../api/client";

interface Props {
  interactions: PendingInteractionView[];
  onAnswer: (interaction: PendingInteractionView, body: { text?: string; approved?: boolean }) => void;
  busy: boolean;
}

function InteractionPanel({ interactions, onAnswer, busy }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (!interactions.length) return <p className="empty">No pending interactions.</p>;
  return (
    <div className="interaction-list">
      {interactions.map((interaction) => (
        <section className="panel-block interaction" key={interaction.id}>
          <span className="eyebrow">{interaction.kind}</span>
          <p>{interaction.prompt}</p>
          {interaction.kind === "approval" ? (
            <div className="button-row">
              <button className="primary" disabled={busy} onClick={() => onAnswer(interaction, { approved: true })}>
                <Check aria-hidden="true" /> Approve
              </button>
              <button disabled={busy} onClick={() => onAnswer(interaction, { approved: false })}>
                <X aria-hidden="true" /> Decline
              </button>
            </div>
          ) : (
            <div className="answer-row">
              <textarea
                value={answers[interaction.id] ?? ""}
                onChange={(event) =>
                  setAnswers((current) => ({ ...current, [interaction.id]: event.target.value }))
                }
              />
              <button
                className="primary icon-only"
                aria-label="Send answer"
                title="Send answer"
                disabled={busy || !(answers[interaction.id] ?? "").trim()}
                onClick={() => onAnswer(interaction, { text: answers[interaction.id] })}
              >
                <Send aria-hidden="true" />
              </button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

export default memo(InteractionPanel);
