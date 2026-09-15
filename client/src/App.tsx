import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch } from "wouter";
import DashboardLayout from "./components/DashboardLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";
import { CandidatesPage, ControlPlanePage, ExceptionsPage, FinancePage, InterviewsPage, JobsPage, PlacementsPage, ProspectsPage, TeamPage } from "./pages/WorkspaceViews";

function withDashboard(Page: React.ComponentType) {
  return () => <DashboardLayout><Page /></DashboardLayout>;
}

const CommandCenter = withDashboard(Home);
const Prospects = withDashboard(ProspectsPage);
const Jobs = withDashboard(JobsPage);
const Candidates = withDashboard(CandidatesPage);
const Interviews = withDashboard(InterviewsPage);
const Placements = withDashboard(PlacementsPage);
const Finance = withDashboard(FinancePage);
const Exceptions = withDashboard(ExceptionsPage);
const Team = withDashboard(TeamPage);
const ControlPlane = withDashboard(ControlPlanePage);

function Router() {
  return <Switch>
    <Route path="/" component={CommandCenter} />
    <Route path="/prospects" component={Prospects} />
    <Route path="/jobs" component={Jobs} />
    <Route path="/candidates" component={Candidates} />
    <Route path="/interviews" component={Interviews} />
    <Route path="/placements" component={Placements} />
    <Route path="/finance" component={Finance} />
    <Route path="/exceptions" component={Exceptions} />
    <Route path="/team" component={Team} />
    <Route path="/control" component={ControlPlane} />
    <Route path="/404" component={NotFound} />
    <Route component={NotFound} />
  </Switch>;
}

export default function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="light"><TooltipProvider><Toaster /><Router /></TooltipProvider></ThemeProvider></ErrorBoundary>;
}
