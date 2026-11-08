/** Read-only, role-specific page tours. Targets are stable page regions, not records. */
export type GuideStep = { target: string; title: string; description: string };
export type WorkspaceGuide = { label: string; steps: readonly GuideStep[] };
export const WORKSPACE_GUIDE_EVENT = 'asinta:workspace-guide';
const step = (target: string, title: string, description: string): GuideStep => ({ target, title, description });
const guide = (label: string, ...steps: GuideStep[]): WorkspaceGuide => ({ label: `${label} guide`, steps });
const filters = step('filters', 'Find a record', 'Search and filters narrow the list. Clear filters when an expected record is not shown.');
const pages: Record<string, WorkspaceGuide> = {
  '/expenses': guide('Expenses',
    step('intro','Site expenses','Record project spending and attach a receipt photo. An expense is not saved until you submit it.'),
    step('action','Record an expense','Open the expense form to enter details manually.'),
    step('draft','Assisted draft','Describe an expense or scan a receipt. AI readings are suggestions: check the photo, amount and category before saving.'),
    filters, step('list','Expense records','Open a saved expense to review its details and receipt. Equipment costs count here when recorded as an expense.')),
  '/invoices': guide('Invoices',
    step('intro','Invoices and billing','See invoices and balances for client projects.'),
    step('action','Create an invoice','Enter and review the billing details before recording an invoice.'),
    filters, step('list','Payments and reminders','Open an invoice to review it, record a payment or prepare a message. Check the ledger before retrying an unconfirmed payment or send.')),
  '/payroll': guide('Payroll',
    step('intro','Payroll','Review attendance-based vouchers and Bale deductions. Finish pending pay before removing a worker from the workforce.'),
    step('action','New payroll run','Choose the period and site, then review the calculated vouchers. Only active workers are included in new runs.'),
    filters, step('list','Review and pay','Review each voucher before approval. Confirm payment only after the worker has been paid. The system attempts the Bale deduction; check the ledger if the outcome is unconfirmed.')),
  '/tools': guide('Tools',
    step('intro','Tools and equipment','Track equipment, quantity, condition and its project or central depot.'),
    step('action','Add equipment','Register an item and choose its location. A rental, purchase or repair is recorded separately as a project expense.'),
    filters, step('list','Inventory','Review each item and update its condition or location when needed.')),
  '/clients': guide('Clients',
    step('intro','Client directory','Keep client contact information for projects and billing.'),
    step('action','Add a client','Enter client details carefully; contact details can be used for payment messages.'),
    filters, step('list','Client records','Open or manage a client. Linked projects and invoices may prevent removal.')),
  '/users': guide('Team accounts',
    step('intro','Team accounts','Founders manage accounts, roles, assigned sites and optional Supervisor payroll profiles.'),
    step('action','Provision an account','Review the role, site assignments and payroll option before creating an account. Share temporary credentials safely.'),
    filters, step('list','Manage accounts','Review changes and any warnings. An unconfirmed account update can be partial; check the account and assigned sites before retrying.')),
  '/reminders': guide('Reminders',
    step('intro','Reminder queue','Review invoices that are approaching or past their due date. Automatic reminders are currently on hold; the Founder sends manually.'),
    step('list','Review before sending','Check the client, balance and message before sending. If a send is unconfirmed, check history and the provider before retrying.')),
  '/sms': guide('SMS history',
    step('intro','SMS dispatch log','Review message history and gateway status. Provider acceptance is not proof of delivery.'),
    step('action','Compose a manual SMS','Review the invoice, recipient and message carefully. Sending can contact the client; check history before retrying an unconfirmed send.'),
    filters, step('list','Message statuses','Check the status and details of previous messages before considering a retry.')),
};
const founderProjects = guide('Projects',
  step('intro','Project sites','See the firm’s projects, their estimates and recorded costs.'),
  step('action','Create a project','Enter the site details and a rough budget estimate. The estimate is not an automatic construction quote.'),
  filters,step('list','Open a site','Open a project to review its team, expenses, invoices, tools and attendance.'));
const supervisorProjects = guide('Projects',
  step('intro','Assigned projects','Only your assigned project sites are shown here.'), filters,
  step('list','Open a site','Open a project to review its workers, tools and attendance.'));
const founderDetail = guide('Project',
  step('intro','Project overview','Review the site details and recorded budget estimate.'),
  step('tabs','Site sections','Choose a section for invoices, expenses, tools, project workers or attendance. Recorded expenses are not automatically a complete payroll cost.'));
const supervisorDetail = guide('Project',
  step('intro','Assigned project','Review this site’s details.'),
  step('tabs','Site sections','Choose a section to view tools, manage the project worker list or review attendance.'));
const founderBale = guide('Bale',
  step('intro','Bale requests and advances','Requests and issued advances are separate. A request does not itself record a payment.'),
  step('tabs','Choose a view','Use Requests for review, or Issued advances for outstanding balances.'),
  step('list','Review carefully','Approve or reject a request; confirm payment only after money is given. Issued advances may be deducted from payroll.'));
const founderBaleIssued = guide('Bale',
  step('intro','Bale requests and advances','Requests and issued advances are separate. A request does not itself record a payment.'),
  step('tabs','Choose a view','Use Requests for review, or Issued advances for outstanding balances.'),
  step('list','Issued advances','Review outstanding advances and recorded deductions. Only record an advance or deduction when the underlying transaction has actually occurred.'));
const supervisorBale = guide('Bale',
  step('intro','Bale requests','Request an advance for a worker at an assigned site. The Founder reviews it.'),
  step('list','Submit and track','Choose a worker and amount. A request is not an issued advance; the Founder confirms payment separately.'));
const history = guide('Attendance history',
  step('intro','Attendance history','Review saved attendance by project and date. The list reflects your account’s access.'),
  filters, step('list','Saved sheets','Expand a sheet to review its records. Refresh when changes may have been made elsewhere.'));
const founderWorkforce = guide('Workforce',
  step('intro','Workforce roster','Add and manage reusable worker profiles. Project teams are managed within each project.'),
  filters, step('list','Active, inactive and removed','Removed profiles retain their history. Removal takes workers off current teams and excludes them from new payroll, including unprocessed dates; restore returns them inactive.'));
const supervisorWorkforce = guide('Workforce',
  step('intro','Workforce roster','Review active worker profiles and add a worker when needed. Project teams are managed within each assigned project.'),
  filters,step('list','Worker profiles','Search by name or craft. Ask the Founder to manage inactive or removed profiles.'));
const founderSettings = guide('Settings',
  step('intro','Firm settings','Review security, integrations and communication templates.'),
  step('details','Integration status','Check whether services are configured. Test messages are real sends; use them only when intended.'));
const supervisorSettings = guide('Settings',
  step('intro','Your profile','Review your account and assigned sites.'),
  step('details','Supervisor profile','Check your assigned projects and workforce link. Ask the Founder if anything looks wrong.'));

export function getWorkspaceGuide(path: string | null, isFounder: boolean, attendanceTab = 'terminal'): WorkspaceGuide | null {
  if (!path || path === '/dashboard' || (path === '/attendance' && attendanceTab === 'terminal')) return null;
  if (path === '/attendance') return attendanceTab === 'history' ? history : attendanceTab === 'workforce' ? (isFounder ? founderWorkforce : supervisorWorkforce) : null;
  if (path === '/projects') return isFounder ? founderProjects : supervisorProjects;
  if (/^\/projects\/[^/]+\/?$/.test(path)) return isFounder ? founderDetail : supervisorDetail;
  if (path === '/advances') return isFounder ? (attendanceTab === 'issued' ? founderBaleIssued : founderBale) : supervisorBale;
  if (path === '/settings') return isFounder ? founderSettings : supervisorSettings;
  return isFounder ? pages[path] || null : null;
}
