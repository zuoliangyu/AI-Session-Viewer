import type { DisplayMessage } from "../../types";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";

interface MessageThreadProps {
  messages: DisplayMessage[];
}

export function MessageThread({ messages }: MessageThreadProps) {
  return (
    <div className="max-w-4xl mx-auto py-6 px-6 space-y-4">
      {messages.map((msg, i) => {
        if (msg.role === "user") {
          return <UserMessage key={msg.uuid || i} message={msg} />;
        } else {
          return <AssistantMessage key={msg.uuid || i} message={msg} />;
        }
      })}
    </div>
  );
}
