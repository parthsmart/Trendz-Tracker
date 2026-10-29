for (const [id, title] of [['milestone-alerts-card','Practice milestones'],['weekly-report-card','Weekly email reports and delivery history']]) {
 const card = document.getElementById(id);
 if (!card) continue;
 const disclosure = document.createElement('details');
 disclosure.className = 'admin-secondary';
 const summary = document.createElement('summary'); summary.textContent = title;
 card.before(disclosure); disclosure.append(summary, card);
}
