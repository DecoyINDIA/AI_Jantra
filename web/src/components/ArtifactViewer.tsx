import { memo } from "react";
import ReactMarkdown from "react-markdown";
import type { ArtifactView } from "../api/client";

interface Props {
  artifacts: ArtifactView[];
}

function ArtifactArticle({ artifact }: { artifact: ArtifactView }) {
  return (
    <article className="panel-block artifact">
      <header>
        <div>
          <span className="eyebrow">{artifact.kind}</span>
          <h3>{artifact.title}</h3>
        </div>
        {artifact.eval ? (
          <span className={artifact.eval.passed ? "badge pass" : "badge fail"}>
            {artifact.eval.passed ? "passed" : "failed"}
          </span>
        ) : null}
      </header>
      <div className="markdown">
        <ReactMarkdown>{artifact.content}</ReactMarkdown>
      </div>
    </article>
  );
}

const MemoArtifactArticle = memo(ArtifactArticle);

function ArtifactViewer({ artifacts }: Props) {
  if (!artifacts.length) return <p className="empty">No artifacts yet.</p>;
  return (
    <div className="artifact-list">
      {artifacts.map((artifact) => (
        <MemoArtifactArticle artifact={artifact} key={`${artifact.stage}:${artifact.kind}:${artifact.version}`} />
      ))}
    </div>
  );
}

export default memo(ArtifactViewer);
