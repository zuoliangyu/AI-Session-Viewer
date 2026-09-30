import { t } from "../../i18n/index.js";
import { useTranslation } from "react-i18next";
import { useState, useRef, useEffect } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useShallow } from "zustand/react/shallow";
import { EscapeToClose } from "../common/EscapeToClose";

interface Props {
  sessionId: string;
  currentAlias: string | null;
  currentTags: string[] | null;
  onClose: () => void;
}

export function SessionMetaEditor({
  sessionId,
  currentAlias,
  currentTags,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [alias, setAlias] = useState(currentAlias || "");
  const [tags, setTags] = useState<string[]>(currentTags || []);
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const { updateSessionMeta, allTags } = useAppStore(
    useShallow((state) => ({ updateSessionMeta: state.updateSessionMeta, allTags: state.allTags })),
  );

  useEffect(() => {
    tagInputRef.current?.focus();
  }, []);

  // Update suggestions when input changes
  useEffect(() => {
    if (tagInput.trim()) {
      const filtered = allTags.filter(
        (t) =>
          t.toLowerCase().includes(tagInput.toLowerCase()) &&
          !tags.includes(t)
      );
      setSuggestions(filtered);
      setSelectedSuggestion(-1);
    } else {
      setSuggestions([]);
    }
  }, [tagInput, allTags, tags]);

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setTagInput("");
    setSuggestions([]);
  };

  const removeTag = (index: number) => {
    setTags(tags.filter((_, i) => i !== index));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (selectedSuggestion >= 0 && selectedSuggestion < suggestions.length) {
        addTag(suggestions[selectedSuggestion]);
      } else if (tagInput.trim()) {
        addTag(tagInput);
      }
    } else if (
      e.key === "Backspace" &&
      !tagInput &&
      tags.length > 0
    ) {
      removeTag(tags.length - 1);
    } else if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setSelectedSuggestion((prev) =>
        prev < suggestions.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setSelectedSuggestion((prev) =>
        prev > 0 ? prev - 1 : suggestions.length - 1
      );
    } else if (e.key === "Escape") {
      if (suggestions.length > 0) {
        setSuggestions([]);
      } else {
        onClose();
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSessionMeta(
        sessionId,
        alias.trim() || null,
        tags
      );
      onClose();
    } catch (err) {
      console.error("Failed to save metadata:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <EscapeToClose onClose={onClose} />
      <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">{t("编辑会话信息")}</h3>
          <button
            aria-label={t("关闭")}
            onClick={onClose}
            className="p-1 rounded hover:bg-accent transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Alias input */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1.5">{t("别名")}</label>
          <input
            type="text"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder={t("为会话设置一个自定义名称...")}
            className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
          />
        </div>

        {/* Tags input */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-1.5">{t("标签")}</label>
          <div className="flex flex-wrap gap-1.5 p-2 bg-background border border-border rounded-md min-h-[38px] focus-within:ring-2 focus-within:ring-ring">
            {tags.map((tag, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/15 text-primary text-xs rounded-full"
              >
                {tag}
                <button
                  aria-label={t("移除标签")}
                  onClick={() => removeTag(i)}
                  className="hover:text-destructive transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            <input
              ref={tagInputRef}
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              placeholder={tags.length === 0 ? t("输入标签后回车添加...") : ""}
              className="flex-1 min-w-[80px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          {/* Suggestions dropdown */}
          {suggestions.length > 0 && (
            <div className="mt-1 bg-card border border-border rounded-md shadow-md max-h-32 overflow-y-auto">
              {suggestions.map((suggestion, i) => (
                <button
                  key={suggestion}
                  onClick={() => addTag(suggestion)}
                  className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors ${
                    i === selectedSuggestion ? "bg-accent" : ""
                  }`}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-md border border-border hover:bg-accent transition-colors"
          >
            {t("取消")}</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {saving ? t("保存中...") : t("保存")}
          </button>
        </div>
      </div>
    </div>
  );
}
