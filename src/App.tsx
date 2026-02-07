import { Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { ProjectsPage } from "./components/project/ProjectsPage";
import { SessionsPage } from "./components/session/SessionsPage";
import { MessagesPage } from "./components/message/MessagesPage";
import { SearchPage } from "./components/search/SearchPage";
import { StatsPage } from "./components/stats/StatsPage";

function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:encodedName" element={<SessionsPage />} />
        <Route
          path="/projects/:encodedName/:sessionId"
          element={<MessagesPage />}
        />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/stats" element={<StatsPage />} />
      </Route>
    </Routes>
  );
}

export default App;
