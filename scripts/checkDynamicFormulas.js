import fs from 'node:fs';

function checkPrimes() {
  const txt = fs.readFileSync('/tmp/jmcwc_dump/j1_07_Primes.txt', 'utf8');
  for (const l of txt.split('\n').slice(5, 15)) console.log('Primes:', l.slice(0, 140));
}

function checkApproximations() {
  const txt = fs.readFileSync('/tmp/jmcwc_dump/j1_15_Approximations.txt', 'utf8');
  for (const l of txt.split('\n').slice(6, 16)) console.log('Appr:', l.slice(0, 140));
}

function checkSumSquares() {
  const txt = fs.readFileSync('/tmp/jmcwc_dump/j1_25_Sums_of_Squares.txt', 'utf8');
  for (const l of txt.split('\n').slice(14, 24)) console.log('SumSq:', l.slice(0, 140));
}

checkPrimes();
checkApproximations();
checkSumSquares();
