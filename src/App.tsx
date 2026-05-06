import { Suspense, lazy, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";

const ProjectsPage = lazy(async () => {
  const module = await import("./components/project/ProjectsPage");
  return { default: module.ProjectsPage };
});
const SessionsPage = lazy(async () => {
  const module = await import("./components/session/SessionsPage");
  return { default: module.SessionsPage };
});
const MessagesPage = lazy(async () => {
  const module = await import("./components/message/MessagesPage");
  return { default: module.MessagesPage };
});
const SearchPage = lazy(async () => {
  const module = await import("./components/search/SearchPage");
  return { default: module.SearchPage };
});
const StatsPage = lazy(async () => {
  const module = await import("./components/stats/StatsPage");
  return { default: module.StatsPage };
});
const ChatPage = lazy(async () => {
  const module = await import("./components/chat/ChatPage");
  return { default: module.ChatPage };
});
const BookmarksPage = lazy(async () => {
  const module = await import("./components/bookmark/BookmarksPage");
  return { default: module.BookmarksPage };
});
const RecyclebinPage = lazy(async () => {
  const module = await import("./components/recyclebin/RecyclebinPage");
  return { default: module.RecyclebinPage };
});
const InvalidItemsPage = lazy(async () => {
  const module = await import("./components/cleanup");
  return { default: module.InvalidItemsPage };
});

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      页面加载中...
    </div>
  );
}

function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route
          path="/projects"
          element={
            <LazyRoute>
              <ProjectsPage />
            </LazyRoute>
          }
        />
        <Route
          path="/projects/:projectId"
          element={
            <LazyRoute>
              <SessionsPage />
            </LazyRoute>
          }
        />
        <Route
          path="/projects/:projectId/session/*"
          element={
            <LazyRoute>
              <MessagesPage />
            </LazyRoute>
          }
        />
        <Route
          path="/search"
          element={
            <LazyRoute>
              <SearchPage />
            </LazyRoute>
          }
        />
        <Route
          path="/stats"
          element={
            <LazyRoute>
              <StatsPage />
            </LazyRoute>
          }
        />
        <Route
          path="/bookmarks"
          element={
            <LazyRoute>
              <BookmarksPage />
            </LazyRoute>
          }
        />
        <Route
          path="/cleanup"
          element={
            <LazyRoute>
              <InvalidItemsPage />
            </LazyRoute>
          }
        />
        <Route
          path="/recyclebin"
          element={
            <LazyRoute>
              <RecyclebinPage />
            </LazyRoute>
          }
        />
        <Route
          path="/chat"
          element={
            <LazyRoute>
              <ChatPage />
            </LazyRoute>
          }
        />
        <Route
          path="/chat/:sessionId"
          element={
            <LazyRoute>
              <ChatPage />
            </LazyRoute>
          }
        />
      </Route>
    </Routes>
  );
}

export default App;
