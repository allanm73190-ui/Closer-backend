'use strict';
// ─── Email Service (Resend) ──────────────────────────────────────────────────
// Centralises all transactional email sending.
// Set RESEND_API_KEY env var to enable emails; if absent, emails are no-ops.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const APP_URL        = process.env.APP_URL        || 'https://closerdebrief.vercel.app';
const FROM           = 'CloserDebrief <onboarding@resend.dev>';

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ from: FROM, to, subject, html }),
  }).catch(err => console.error('[email] send failed:', err?.message));
}

// ─── Email Templates ──────────────────────────────────────────────────────────

function baseLayout(content) {
  return `<div style="font-family:Arial;max-width:480px;margin:0 auto">
    <h2 style="color:#FF7E5F">CloserDebrief</h2>
    ${content}
    <p style="color:#94a3b8;font-size:12px;margin-top:24px">L'équipe CloserDebrief</p>
  </div>`;
}

function ctaButton(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#FF7E5F;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">${label}</a>`;
}

// Password reset
async function sendPasswordReset({ to, name, resetToken }) {
  const link = `${APP_URL}?reset_token=${resetToken}`;
  await sendEmail({
    to,
    subject: 'Réinitialisation de votre mot de passe',
    html: baseLayout(`
      <p>Bonjour ${name},</p>
      <p>Vous avez demandé à réinitialiser votre mot de passe.</p>
      ${ctaButton(link, 'Réinitialiser mon mot de passe')}
      <p style="color:#94a3b8;font-size:12px;margin-top:16px">Ce lien expire dans 1h. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
    `),
  });
}

// Welcome email after registration
async function sendWelcome({ to, name }) {
  await sendEmail({
    to,
    subject: 'Bienvenue sur CloserDebrief !',
    html: baseLayout(`
      <p>Bonjour ${name},</p>
      <p>Votre compte CloserDebrief est prêt. Commencez à suivre vos appels et progresser dès maintenant.</p>
      ${ctaButton(APP_URL, 'Accéder à mon espace')}
    `),
  });
}

// New debrief shared by manager
async function sendDebriefShared({ to, name, debriefId, prospect }) {
  const link = `${APP_URL}?debrief_id=${debriefId}`;
  await sendEmail({
    to,
    subject: `Nouveau débrief partagé : ${prospect}`,
    html: baseLayout(`
      <p>Bonjour ${name},</p>
      <p>Un nouveau débrief a été partagé avec vous : <strong>${prospect}</strong>.</p>
      ${ctaButton(link, 'Voir le débrief')}
    `),
  });
}

// Invite to join a team
async function sendTeamInvite({ to, inviterName, teamName, inviteCode }) {
  const link = `${APP_URL}?invite=${inviteCode}`;
  await sendEmail({
    to,
    subject: `${inviterName} vous invite à rejoindre ${teamName}`,
    html: baseLayout(`
      <p>Bonjour,</p>
      <p><strong>${inviterName}</strong> vous invite à rejoindre l'équipe <strong>${teamName}</strong> sur CloserDebrief.</p>
      ${ctaButton(link, 'Rejoindre l\'équipe')}
      <p style="color:#94a3b8;font-size:12px;margin-top:16px">Code d'invitation : <code>${inviteCode}</code></p>
    `),
  });
}

// Weekly performance summary
async function sendWeeklySummary({ to, name, stats }) {
  await sendEmail({
    to,
    subject: 'Votre résumé hebdomadaire CloserDebrief',
    html: baseLayout(`
      <p>Bonjour ${name},</p>
      <p>Voici votre résumé de la semaine :</p>
      <ul>
        <li>Debriefs créés : <strong>${stats.debriefs || 0}</strong></li>
        <li>Score qualité moyen : <strong>${stats.avgQuality || 0}/100</strong></li>
        <li>Deals trackés : <strong>${stats.deals || 0}</strong></li>
      </ul>
      ${ctaButton(APP_URL, 'Voir mon tableau de bord')}
    `),
  });
}

// Objective achieved
async function sendObjectiveAchieved({ to, name, objectiveTitle }) {
  await sendEmail({
    to,
    subject: `Objectif atteint : ${objectiveTitle} 🎉`,
    html: baseLayout(`
      <p>Bravo ${name} !</p>
      <p>Vous avez atteint votre objectif : <strong>${objectiveTitle}</strong>.</p>
      ${ctaButton(APP_URL, 'Voir mes objectifs')}
    `),
  });
}

// Review request from manager
async function sendReviewRequest({ to, name, debriefId, prospect, reviewerName }) {
  const link = `${APP_URL}?debrief_id=${debriefId}`;
  await sendEmail({
    to,
    subject: `${reviewerName} a commenté votre débrief`,
    html: baseLayout(`
      <p>Bonjour ${name},</p>
      <p><strong>${reviewerName}</strong> a laissé un retour sur votre débrief <strong>${prospect}</strong>.</p>
      ${ctaButton(link, 'Voir le commentaire')}
    `),
  });
}

module.exports = {
  sendPasswordReset,
  sendWelcome,
  sendDebriefShared,
  sendTeamInvite,
  sendWeeklySummary,
  sendObjectiveAchieved,
  sendReviewRequest,
};
