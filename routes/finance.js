const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const RECEIPT_PREFIX = process.env.RECEIPT_PREFIX || 'UEC-2026-';
const RECEIPT_START_SEQ = parseInt(process.env.RECEIPT_START_SEQ) || 1001;

router.get('/dashboard', authMiddleware(['finance']), async (req, res) => {
  try {
    const { rows: users } = await db.query('SELECT * FROM users WHERE username = $1 AND role = $2', [req.user.token, 'finance']);
    if (users.length === 0) return res.json({ success: false, message: 'Access Denied.' });

    const { rows: requests } = await db.query(`
      SELECT r.*, s.name as student_name, s.faculty
      FROM requests r JOIN students s ON r.student_id = s.student_id
      WHERE r.status IN ('Approved by Supervisor', 'Pending Payment', 'Partially Paid', 'Registered Successfully')
    `);

    const { rows: allPayments } = await db.query(
      "SELECT * FROM payments WHERE status IN ('Verified', 'Settlement/Discount')"
    );

    const { rows: allSelections } = await db.query(`
      SELECT cs.*, c.course_name FROM course_selections cs
      JOIN courses c ON cs.course_code = c.course_code
    `);

    const financeRequests = requests.map(r => {
      const reqPayments = allPayments.filter(p => String(p.request_id) === String(r.request_id));
      const selCourses = allSelections.filter(sel => sel.request_id === r.request_id).map(sel => sel.course_name).join(' - ');

      let totalPaid = 0;
      reqPayments.forEach(p => { totalPaid += parseFloat(p.amount_paid) || 0; });
      let remaining = Number(r.total_fees) - totalPaid;

      let computedStatus = r.status;
      if (remaining <= 0) computedStatus = 'Registered Successfully';
      else if (totalPaid > 0) computedStatus = 'Partially Paid';

      return {
        requestId: r.request_id, studentId: r.student_id, studentName: r.student_name,
        faculty: r.faculty || 'General', totalFees: Number(r.total_fees),
        paidAmount: totalPaid, remainingAmount: remaining, status: computedStatus,
        courses: selCourses,
        paymentsHistory: reqPayments.map(p => ({
          amount: Number(p.amount_paid), date: p.payment_date, receiptNo: p.receipt_no,
          method: p.payment_method, status: p.status, refNum: p.reference_number
        }))
      };
    });

    return res.json({ success: true, requests: financeRequests });
  } catch (error) {
    console.error('Finance dashboard error:', error);
    return res.json({ success: false, message: 'Server error.' });
  }
});

router.post('/processPayment', authMiddleware(['finance']), async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { requestId, amountToPay, refNum, paymentMethod, paymentDate, email, discountPercent, approvedBy } = req.body;

    const { rows } = await client.query('SELECT * FROM requests WHERE request_id = $1', [requestId]);
    if (rows.length === 0) { await client.query('ROLLBACK'); return res.json({ success: false, message: 'Request not found.' }); }
    const requestRow = rows[0];

    let paymentAmt = Number(amountToPay || 0);
    let discountPerc = Number(discountPercent || 0);
    let discountAmount = 0;
    if (discountPerc > 0) discountAmount = Math.round(Number(requestRow.total_fees) * (discountPerc / 100));

    const { rows: paidRows } = await client.query(
      "SELECT COALESCE(SUM(amount_paid), 0)::numeric as total FROM payments WHERE request_id = $1 AND status IN ('Verified', 'Settlement/Discount')",
      [requestId]
    );
    const totalPaidSoFar = parseFloat(paidRows[0].total) || 0;

    if ((totalPaidSoFar + paymentAmt + discountAmount) > Number(requestRow.total_fees)) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Payment exceeds total fees.' });
    }

    const pDate = paymentDate ? new Date(paymentDate) : new Date();
    const ref = refNum || 'N/A';
    const method = paymentMethod || 'N/A';

    const { rows: payCount } = await client.query('SELECT COUNT(*)::int as cnt FROM payments');
    let nextSeq = RECEIPT_START_SEQ + payCount[0].cnt;
    let newReceiptNo = '';

    if (paymentAmt > 0) {
      newReceiptNo = RECEIPT_PREFIX + nextSeq;
      await client.query(
        'INSERT INTO payments (transaction_id, request_id, student_id, amount_paid, reference_number, payment_date, status, payment_method, receipt_no) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [uuidv4(), requestId, requestRow.student_id, paymentAmt, ref, pDate, 'Verified', method, newReceiptNo]
      );
      nextSeq++;
    }

    if (discountAmount > 0) {
      let discReceipt = RECEIPT_PREFIX + nextSeq;
      await client.query(
        'INSERT INTO payments (transaction_id, request_id, student_id, amount_paid, reference_number, payment_date, status, payment_method, receipt_no) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [uuidv4(), requestId, requestRow.student_id, discountAmount, `Discount ${discountPerc}% - ${approvedBy}`, pDate, 'Settlement/Discount', 'Discount', discReceipt]
      );
      if (!newReceiptNo) newReceiptNo = discReceipt;
    }

    const newStatus = (totalPaidSoFar + paymentAmt + discountAmount) >= Number(requestRow.total_fees) ? 'Registered Successfully' : 'Partially Paid';
    await client.query(
      'UPDATE requests SET status = $1, reference_number = $2, payment_date = $3 WHERE request_id = $4',
      [newStatus, ref !== 'N/A' ? ref : 'Discount Applied', pDate, requestId]
    );

    await client.query('COMMIT');
    return res.json({ success: true, message: 'Payment processed.', receiptNo: newReceiptNo });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Finance action error:', error.message);
    return res.json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

module.exports = router;
