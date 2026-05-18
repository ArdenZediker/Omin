import type { PetThoughtState } from "../../app/types";

type PetThoughtBubbleProps = {
  thought: PetThoughtState | null;
};

export default function PetThoughtBubble({ thought }: PetThoughtBubbleProps) {
  if (!thought) {
    return null;
  }

  const previewText =
    thought.status === "thinking" && !thought.previewText.trim() ? "正在思考..." : thought.previewText.trim();

  return (
    <div className={`pet-thought-bubble pet-thought-bubble--${thought.status} no-drag`}>
      <div className="pet-thought-bubble__title" title={thought.sessionTitle}>
        {thought.sessionTitle}
      </div>
      {previewText ? (
        <div className="pet-thought-bubble__preview" title={previewText}>
          {previewText}
        </div>
      ) : null}
    </div>
  );
}
