import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  type RouteComponent,
} from "@tanstack/react-router";
import { RootLayout } from "@/components/layout";
import { getSessionToken } from "@/lib/api";
import { LoginPage } from "@/pages/login";

const rootRoute = createRootRoute({ component: Outlet });
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: RootLayout,
  beforeLoad: () => {
    if (!getSessionToken()) throw redirect({ to: "/login" });
  },
});

const lazyPage = (
  importer: () => Promise<Record<string, unknown>>,
  exportName: string,
): RouteComponent =>
  lazyRouteComponent(importer, exportName as never) as RouteComponent;
const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: lazyPage(() => import("@/pages/dashboard"), "DashboardPage"),
});
const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    createRoute({
      getParentRoute: () => appRoute,
      path: "/timetable",
      component: lazyPage(() => import("@/pages/timetable"), "TimetablePage"),
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/courses",
      component: lazyPage(() => import("@/pages/courses"), "CoursesPage"),
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/assignments",
      component: lazyPage(
        () => import("@/pages/assignments"),
        "AssignmentsPage",
      ),
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/grades",
      component: lazyPage(() => import("@/pages/grades"), "GradesPage"),
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/exams",
      component: lazyPage(() => import("@/pages/exams"), "ExamsPage"),
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/tuition",
      component: lazyPage(() => import("@/pages/tuition"), "TuitionPage"),
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/documents",
      component: lazyPage(() => import("@/pages/documents"), "DocumentsPage"),
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/training-points",
      component: lazyPage(
        () => import("@/pages/training-points"),
        "TrainingPointsPage",
      ),
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/lookup",
      component: lazyPage(() => import("@/pages/lookup"), "LookupPage"),
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/settings",
      component: lazyPage(() => import("@/pages/settings"), "SettingsPage"),
    }),
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
