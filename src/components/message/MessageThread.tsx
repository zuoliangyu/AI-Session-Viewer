import type { DisplayMessage } from "../../types";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ToolOutputMessage } from "./ToolOutputMessage";

interface MessageThreadProps {
  messages: DisplayMessage[];
  source: string;
}

export function MessageThread({ messages, source }: MessageThreadProps) {
  return (
    <div className="max-w-4xl mx-auto py-6 px-6 space-y-4">
      {messages.map((msg, i) => {
        if (msg.role === "user") {
          return <UserMessage key={msg.uuid || i} message={msg} />;
        }
        if (msg.role === "tool") {
          return <ToolOutputMessage key={msg.uuid || i} message={msg} />;
        }
        return <AssistantMessage key={msg.uuid || i} message={msg} source={source} />;
      })}
    </div>
  );
}
