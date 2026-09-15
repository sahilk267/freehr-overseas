import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { startLogin } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  BadgeDollarSign,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  LayoutDashboard,
  LogOut,
  PanelLeft,
  Settings2,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";

const menuItems = [
  { icon: LayoutDashboard, label: "Command Center", path: "/" },
  { icon: Building2, label: "Prospects", path: "/prospects" },
  { icon: BriefcaseBusiness, label: "Jobs", path: "/jobs" },
  { icon: UsersRound, label: "Candidates", path: "/candidates" },
  { icon: CalendarDays, label: "Interviews", path: "/interviews" },
  { icon: ShieldCheck, label: "Placements", path: "/placements" },
  { icon: BadgeDollarSign, label: "Finance", path: "/finance" },
  { icon: CircleAlert, label: "Exceptions", path: "/exceptions" },
  { icon: UsersRound, label: "Team & access", path: "/team" },
  { icon: Settings2, label: "Control Plane", path: "/control" },
];

const memberPaths = {
  recruiter: new Set(["/", "/prospects", "/jobs", "/candidates", "/interviews", "/team"]),
  coordinator: new Set(["/", "/candidates", "/interviews", "/team"]),
  finance: new Set(["/", "/placements", "/finance", "/team"]),
  viewer: new Set(["/", "/prospects", "/jobs", "/candidates", "/interviews", "/placements", "/finance", "/team"]),
} as const;

const SIDEBAR_WIDTH_KEY = "freelancehr-sidebar-width";
const DEFAULT_WIDTH = 278;
const MIN_WIDTH = 220;
const MAX_WIDTH = 360;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) return <DashboardLayoutSkeleton />;

  if (!user) {
    return (
      <div className="min-h-screen bg-[#f7f5f0] p-5 flex items-center justify-center text-slate-950">
        <div className="w-full max-w-md rounded-[2rem] border border-slate-200 bg-white p-10 shadow-[0_30px_80px_-35px_rgba(15,23,42,0.4)]">
          <div className="mb-8 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#10213d] text-sm font-black tracking-[0.2em] text-[#f5d77b]">FH</div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#a47d2c]">Private recruiting operations</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[#10213d]">Welcome to FreelanceHR.</h1>
          <p className="mt-4 leading-7 text-slate-600">Sign in to access your controlled recruitment workspace, approvals, and audit-ready pipelines.</p>
          <Button onClick={() => startLogin()} size="lg" className="mt-8 w-full bg-[#10213d] text-white hover:bg-[#1a3156]">Sign in securely <ChevronRight className="ml-1 h-4 w-4" /></Button>
        </div>
      </div>
    );
  }

  return <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}><DashboardLayoutContent setSidebarWidth={setSidebarWidth}>{children}</DashboardLayoutContent></SidebarProvider>;
}

function DashboardLayoutContent({ children, setSidebarWidth }: { children: React.ReactNode; setSidebarWidth: (width: number) => void }) {
  const { user, logout } = useAuth();
  const { data: memberAccess } = trpc.team.myAccess.useQuery(undefined, { enabled: Boolean(user && user.role !== "admin") });
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeMenuItem = menuItems.find(item => item.path === location);
  const permittedMemberPaths = memberAccess && memberAccess.role !== "owner" ? memberPaths[memberAccess.role] : null;
  const visibleMenuItems = user?.role === "admin" || memberAccess?.role === "owner" ? menuItems : permittedMemberPaths ? menuItems.filter(item => permittedMemberPaths.has(item.path)) : menuItems.filter(item => item.path === "/team");
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isCollapsed) setIsResizing(false);
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizing) return;
      const left = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const width = event.clientX - left;
      if (width >= MIN_WIDTH && width <= MAX_WIDTH) setSidebarWidth(width);
    };
    const stop = () => setIsResizing(false);
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", stop);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div ref={sidebarRef} className="relative">
        <Sidebar collapsible="icon" className="border-r border-[#263954] bg-[#10213d] text-white" disableTransition={isResizing}>
          <SidebarHeader className="h-[92px] justify-center px-4">
            <div className="flex items-center gap-3">
              <button onClick={toggleSidebar} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-white transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f5d77b]" aria-label="Toggle navigation"><PanelLeft className="h-4 w-4" /></button>
              {!isCollapsed && <div className="min-w-0"><div className="text-[10px] font-bold tracking-[0.2em] text-[#f5d77b]">FREELANCEHR</div><div className="mt-1 text-sm font-medium text-white">Recruiting operations</div></div>}
            </div>
          </SidebarHeader>
          <SidebarContent className="gap-0 px-3">
            {!isCollapsed && <p className="px-3 pb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Workspace</p>}
            <SidebarMenu className="gap-1">
              {visibleMenuItems.map(item => {
                const active = location === item.path;
                return <SidebarMenuItem key={item.path}><SidebarMenuButton isActive={active} onClick={() => setLocation(item.path)} tooltip={item.label} className={`h-10 rounded-xl px-3 text-slate-300 transition-all hover:bg-white/10 hover:text-white data-[active=true]:bg-[#f5d77b] data-[active=true]:text-[#10213d] ${active ? "font-semibold" : ""}`}><item.icon className="h-4 w-4" /><span>{item.label}</span></SidebarMenuButton></SidebarMenuItem>;
              })}
            </SidebarMenu>
          </SidebarContent>
          <SidebarFooter className="border-t border-white/10 p-3">
            {!isCollapsed && <div className="mb-3 rounded-xl border border-white/10 bg-white/5 p-3"><div className="flex items-center gap-2 text-xs font-medium text-[#f5d77b]"><Activity className="h-3.5 w-3.5" />Controlled mode</div><p className="mt-1 text-[11px] leading-4 text-slate-300">Owner approval is active for consequential actions.</p></div>}
            <DropdownMenu><DropdownMenuTrigger asChild><button className="flex w-full items-center gap-3 rounded-xl px-1 py-1 text-left transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f5d77b]"><Avatar className="h-9 w-9 border border-white/20"><AvatarFallback className="bg-[#25446f] text-xs font-semibold text-white">{user?.name?.charAt(0).toUpperCase() || "O"}</AvatarFallback></Avatar><div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden"><p className="truncate text-sm font-medium text-white">{user?.name || "Owner"}</p><p className="mt-0.5 truncate text-[11px] text-slate-400">Secure workspace</p></div></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-48"><DropdownMenuItem onClick={logout} className="cursor-pointer text-destructive focus:text-destructive"><LogOut className="mr-2 h-4 w-4" />Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div className={`absolute right-0 top-0 z-50 h-full w-1 cursor-col-resize transition-colors hover:bg-[#f5d77b]/60 ${isCollapsed ? "hidden" : ""}`} onMouseDown={() => setIsResizing(true)} />
      </div>
      <SidebarInset className="min-h-screen bg-[#f7f5f0] text-slate-950">
        {isMobile && <div className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-slate-200 bg-[#f7f5f0]/95 px-4 backdrop-blur"><SidebarTrigger className="rounded-lg" /><span className="text-sm font-semibold text-[#10213d]">{activeMenuItem?.label ?? "FreelanceHR"}</span></div>}
        <main className="min-h-screen p-4 sm:p-6 lg:p-8">{children}</main>
      </SidebarInset>
    </>
  );
}
