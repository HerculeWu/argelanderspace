/**
 * Stage 10 Writer — pane view: manuscript list ↔ editor. Each pane keeps its
 * own open-manuscript state (panes are independent views, shell precedent).
 * M2b: deleting the open doc elsewhere (WS) returns to the list with a note.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ManuscriptList } from "./ManuscriptList";
import { WriterEditor } from "./WriterEditor";

export function WriterView() {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  // bumping the key remounts the editor when the same id is re-opened
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  if (!openId)
    return (
      <ManuscriptList
        notice={notice}
        onOpen={(id) => {
          setNotice(null);
          setSession((s) => s + 1);
          setOpenId(id);
        }}
      />
    );
  return (
    <WriterEditor
      key={`${openId}:${session}`}
      id={openId}
      onBack={() => setOpenId(null)}
      onGone={() => {
        setOpenId(null);
        setNotice(t("writer.list.deletedElsewhere"));
      }}
    />
  );
}
