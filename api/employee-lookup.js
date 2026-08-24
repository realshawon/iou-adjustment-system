// GET /api/employee-lookup?empId=<emp_code>
//
// Resolves an Employee ID against the ERP so the IOU form never depends on
// someone typing their own department and designation correctly. The ERP is the
// source of truth: erp.aksidcorp.com owns employee.department_id /
// designation_id, and this reads through those joins live.
//
// Read-only and deliberately narrow. It returns only the four fields the IOU
// form needs plus contact details the form already collects — no salary, no
// national ID, no date of birth, nothing else on the employee record.
import { neon } from '@neondatabase/serverless';

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const raw = String(req.query.empId || req.query.id || '').trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'Employee ID is required.' });
  // Guard against someone probing with an empty-ish or absurd value.
  if (raw.length > 40) return res.status(400).json({ ok: false, error: 'Employee ID is not valid.' });

  const erpSql = erp();
  if (!erpSql) {
    return res.status(503).json({ ok: false, error: 'ERP lookup is not configured yet.' });
  }

  try {
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
