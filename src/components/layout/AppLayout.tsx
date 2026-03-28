import { Outlet } from "react-router-dom";
import { ScrollArea } from "../ScrollArea";
import { Sidebar } from "./Sidebar";
import { UpdateToast } from "./UpdateIndicator";

export function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 min-w-0">
        <ScrollArea className="h-full" viewportClassName="h-full">
          <Outlet />
        </ScrollArea>
      </main>
      <UpdateToast />
    </div>
  );
}
