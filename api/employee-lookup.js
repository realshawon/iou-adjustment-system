// GET /api/employee-lookup?empId=<emp_code>
//
// Resolves an Employee ID against the ERP so the IOU form never depends on
// someone typing their own department and designation correctly. The ERP is the
// source of truth: erp.aksidcorp.com owns employee.department_id /
// designation_id, and this reads through those joins live.
//
// AUTHENTICATION REQUIRED (2026-08-24). The IOU tracker and the submission form
// are deliberately open, but this endpoint is not: without a login it would let
// anyone walk sequential employee codes and harvest the staff directory. The
// session is the same ERP-backed one used elsewhere — no password is stored
// here and nothing sensitive reaches the browser.
//
// Scope: a signed-in user may look up THEIR OWN record. Directory-wide lookup is
// limited to the HR/admin roles that already have that visibility in the ERP, so
// an ordinary user cannot enumerate colleagues by editing the query string.
import { neon } from '@neondatabase/serverless';
import { getSession } from './_auth.js';

// Built lazily. neon() throws when handed an undefined connection string, and
// at module scope that crashes the whole function before the handler can return
// a useful error — so resolve it per request instead.
let _erpSql = null;
function erp() {
  const url = process.env.ERP_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) return null;
  if (!_erpSql) _erpSql = neon(url);
  return _erpSql;
}

// Roles whose ERP access already spans the whole staff directory.
const DIRECTORY_ROLES = new Set(['superadmin', 'admin', 'hr']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const session = await getSession(req);
  if (!session) {
    return res.status(401).json({
      ok: false,
      error: 'Sign in with your ERP account to look up employee details.',
      login: '/login.html',
    });
  }

  const raw = String(req.query.empId || req.query.id || '').trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'Employee ID is required.' });
  if (raw.length > 40) return res.status(400).json({ ok: false, error: 'Employee ID is not valid.' });

  const erpSql = erp();
  if (!erpSql) {
    return res.status(503).json({ ok: false, error: 'ERP lookup is not configured yet.' });
  }

  try {
    // Only the columns the IOU form needs. Salary, national_id, date_of_birth
    // and everything else on the employee record are never selected, so they
    // cannot leak through this endpoint even by accident.
    const rows = await erpSql`
      SELECT e.emp_code, e.full_name, e.email, e.mobile,
             d.name AS department, g.name AS designation
        FROM employee e
        LEFT JOIN department  d ON d.id = e.department_id
        LEFT JOIN designation g ON g.id = e.designation_id
       WHERE lower(e.emp_code) = ${raw.toLowerCase()}
         AND e.job_status = 'Active'
       LIMIT 1`;

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'No active employee found with that ID in the ERP.' });
    }
    const e = rows[0];

    // Authorisation, checked AFTER the row is loaded so the comparison is made
    // against the real record rather than anything the caller supplied.
    const isSelf = session.empCode && String(session.empCode).toLowerCase() === String(e.emp_code).toLowerCase();
    const isDirectory = DIRECTORY_ROLES.has(session.role);
    if (!isSelf && !isDirectory) {
      return res.status(403).json({
        ok: false,
        error: 'You can only look up your own Employee ID. Enter your own, or ask HR to submit on your behalf.',
      });
    }

    return res.status(200).json({
      ok: true,
      employee: {
        empCode: e.emp_code,
        name: e.full_name || '',
        email: e.email || '',
        mobile: e.mobile || '',
        department: e.department || '',
        designation: e.designation || '',
      },
    });
  } catch (err) {
    console.error('employee-lookup failed —', err.message);
    return res.status(500).json({ ok: false, error: 'Could not reach the ERP right now.' });
  }
}
