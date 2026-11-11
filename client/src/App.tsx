import CandidateReviewPage from './pages/CandidateReviewPage';
import DiscoveryResponsePage from "./pages/DiscoveryResponsePage";
import InterviewResponsePage from "./pages/InterviewResponsePage";
import AvailabilityResponsePage from "./pages/AvailabilityResponsePage";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch } from "wouter";
import DashboardLayout from "./components/DashboardLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import FollowUpsPage from "./pages/FollowUpsPage";
import CampaignsPage from "./pages/CampaignsPage";
import IntakePage from "./pages/IntakePage";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";
import TeamAcceptPage from "./pages/TeamAcceptPage";
import OwnerLoginPage from "./pages/OwnerLoginPage";
import { CandidatesPage, ControlPlanePage, ExceptionsPage, FinancePage, InterviewsPage, JobsPage, PlacementsPage, ProspectsPage, TeamPage } from "./pages/WorkspaceViews";

function withDashboard(Page: React.ComponentType) {
  return () => <DashboardLayout><Page /></DashboardLayout>;
}

const CommandCenter = withDashboard(Home);
const Prospects = withDashboard(ProspectsPage);
const Jobs = withDashboard(JobsPage);
const Candidates = withDashboard(CandidatesPage);
const FollowUps = withDashboard(FollowUpsPage);
const Campaigns = withDashboard(CampaignsPage);
const Intake = withDashboard(IntakePage);
const Interviews = withDashboard(InterviewsPage);
const Placements = withDashboard(PlacementsPage);
const Finance = withDashboard(FinancePage);
const Exceptions = withDashboard(ExceptionsPage);
const Team = withDashboard(TeamPage);
const ControlPlane = withDashboard(ControlPlanePage);

function PaymentReturnPage() {
  return <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 px-6 py-12 text-slate-800"><p className="text-sm font-semibold tracking-wide">FreelanceHR</p><h1 className="text-3xl font-semibold">You have returned from checkout</h1><p>Returning here does not confirm a successful payment. Your agency will confirm your invoice payment after checking with the payment provider.</p><p>Keep your provider receipt and contact your agency representative if you need help. You may close this page.</p></main>;
}

function Router() {
  return <Switch>
    <Route path="/payment-return" component={PaymentReturnPage} />
    <Route path="/candidate-review" component={CandidateReviewPage} />
    <Route path="/interview-response" component={InterviewResponsePage} />
    <Route path="/discovery-response" component={DiscoveryResponsePage} />
    <Route path="/availability" component={AvailabilityResponsePage} />
    <Route path="/login" component={OwnerLoginPage} />
    <Route path="/" component={CommandCenter} />
    <Route path="/prospects" component={Prospects} />
    <Route path="/jobs" component={Jobs} />
    <Route path="/candidates" component={Candidates} />
    <Route path="/follow-ups" component={FollowUps} />
    <Route path="/campaigns" component={Campaigns} />
    <Route path="/intake" component={Intake} />
    <Route path="/interviews" component={Interviews} />
    <Route path="/placements" component={Placements} />
    <Route path="/finance" component={Finance} />
    <Route path="/exceptions" component={Exceptions} />
    <Route path="/team" component={Team} />
    <Route path="/team/accept" component={TeamAcceptPage} />
    <Route path="/control" component={ControlPlane} />
    <Route path="/404" component={NotFound} />
    <Route component={NotFound} />
  </Switch>;
}

export default function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="light"><TooltipProvider><Toaster /><Router /></TooltipProvider></ThemeProvider></ErrorBoundary>;
}
