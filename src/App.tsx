/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import firebase, { auth, db } from './firebase';

const EMAIL_DOMAIN = 'arbeitszeiten.local';

function getTargetMinutesForDate(d: string): number {
  if (!d) return 8 * 60 + 12;
  const parts = d.split('-').map(Number);
  const dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
  const dayOfWeek = dateObj.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return 0;
  }
  return 8 * 60 + 12;
}

function nameToEmail(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean + '@' + EMAIL_DOMAIN;
}

function dateKey(d: Date | string): string {
  if (typeof d === 'string') return d;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTimeInput(value: string): string {
  let digits = value.replace(/\D/g, '');
  if (digits.length > 4) digits = digits.substring(0, 4);
  if (!digits) return '';
  if (digits.length >= 3) return digits.substring(0, 2) + ':' + digits.substring(2);
  return digits;
}

function formatReserveInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === '+' || trimmed === '-') return trimmed;

  const isNeg = trimmed.startsWith('-');
  const isExplicitPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '').substring(0, 4);

  if (!digits) {
    return isNeg ? '-' : isExplicitPlus ? '+' : '';
  }

  let formatted = digits;
  if (digits.length >= 3) {
    formatted = digits.substring(0, 2) + ':' + digits.substring(2);
  }

  if (isNeg) return '-' + formatted;
  if (isExplicitPlus) return '+' + formatted;
  return '+' + formatted;
}

function toggleReserveSign(val: string): string {
  const trimmed = val.trim();
  if (trimmed.startsWith('-')) {
    return '+' + trimmed.substring(1);
  } else if (trimmed.startsWith('+')) {
    return '-' + trimmed.substring(1);
  } else {
    return '-' + trimmed;
  }
}

function parseTimeToMinutes(timeStr: string | null | undefined): number | null {
  if (!timeStr) return null;
  const trimmed = timeStr.trim();
  if (trimmed === '' || trimmed === '+' || trimmed === '-') return 0;
  const isNeg = trimmed.startsWith('-') || trimmed.includes('-');
  const clean = trimmed.replace(/[^0-9:]/g, '');
  if (!clean) return 0;
  if (!clean.includes(':')) {
    const num = parseInt(clean, 10);
    return isNaN(num) ? null : isNeg ? -num * 60 : num * 60;
  }
  const [h, m] = clean.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const mins = h * 60 + m;
  return isNeg ? -mins : mins;
}

function formatMinutes(mins: number, showPlus = false): string {
  const isNeg = mins < 0;
  const absMins = Math.abs(mins);
  const h = Math.floor(absMins / 60);
  const m = absMins % 60;
  const formatted = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  if (isNeg) return '-' + formatted;
  if (showPlus && mins >= 0) return '+' + formatted;
  return formatted;
}

interface SlotData {
  begin: string;
  ende: string;
  kommentar: string;
}

interface DayData {
  id?: string;
  vormittag?: SlotData;
  nachmittag?: SlotData;
  reserve?: string;
  calculatedNewReserve?: string;
  workSumMinutes?: number;
  daySaldoMinutes?: number;
  targetMinutes?: number;
}

interface ProcessedDayData extends DayData {
  calculatedWorkMins: number;
  calculatedTargetMins: number;
  calculatedSaldoMins: number;
  manualReserveMins: number;
  manualReserveStr: string;
  dayZeitguthabenMins: number;
  dayZeitguthabenStr: string;
}

export default function App() {
  // Auth state
  const [user, setUser] = useState<firebase.User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [loginName, setLoginName] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // App navigation
  const [activeTab, setActiveTab] = useState<'daily' | 'overview'>('daily');

  // Daily Tracker state
  const [currentDateObj, setCurrentDateObj] = useState<Date>(() => {
    const d = new Date();
    if (d.getDay() === 6) d.setDate(d.getDate() + 2);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    return d;
  });

  const [vBegin, setVBegin] = useState('');
  const [vEnde, setVEnde] = useState('');
  const [vKommentar, setVKommentar] = useState('');

  const [nBegin, setNBegin] = useState('');
  const [nEnde, setNEnde] = useState('');
  const [nKommentar, setNKommentar] = useState('');

  const [reserve, setReserve] = useState('+00:00');
  const [syncStatus, setSyncStatus] = useState('Lade…');

  // Overview All-Days raw state from Firestore
  const [overviewDays, setOverviewDays] = useState<DayData[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  // Overview Add/Edit form state
  const [ovDate, setOvDate] = useState<string>(() => dateKey(new Date()));
  const [ovVBegin, setOvVBegin] = useState('');
  const [ovVEnde, setOvVEnde] = useState('');
  const [ovVKommentar, setOvVKommentar] = useState('');
  const [ovNBegin, setOvNBegin] = useState('');
  const [ovNEnde, setOvNEnde] = useState('');
  const [ovNKommentar, setOvNKommentar] = useState('');
  const [ovReserve, setOvReserve] = useState('+00:00');
  const [ovFormStatus, setOvFormStatus] = useState('Bereit');
  const [ovSubmitting, setOvSubmitting] = useState(false);

  // Delete Confirmation Modal State
  const [dayToDelete, setDayToDelete] = useState<string | null>(null);

  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingSavePayload = useRef<any>(null);
  const isInitialLoad = useRef(true);

  // Auth observer
  useEffect(() => {
    const unsubscribeAuth = auth.onAuthStateChanged((u) => {
      setUser(u);
      if (u) {
        setAuthError('');
        setLoginPassword('');
      }
    });
    return () => unsubscribeAuth();
  }, []);

  // Fetch / Listen to Overview days in real time
  useEffect(() => {
    if (!user) return;
    setOverviewLoading(true);

    const unsubscribe = db
      .collection('users')
      .doc(user.uid)
      .collection('days')
      .onSnapshot(
        (snap) => {
          if (!snap || snap.empty) {
            setOverviewDays([]);
            setOverviewLoading(false);
            return;
          }
          const list: DayData[] = [];
          snap.forEach((doc) => {
            list.push({ id: doc.id, ...doc.data() });
          });
          setOverviewDays(list);
          setOverviewLoading(false);
        },
        (err) => {
          console.error('Overview snapshot error:', err);
          setOverviewLoading(false);
        }
      );

    return () => unsubscribe();
  }, [user]);

  // Process all days: Each day has its work time, saldo, and manual reserve (+00:00 by default)
  const processedOverviewDays: ProcessedDayData[] = useMemo(() => {
    // 1. Filter days that have some logged time or manual reserve
    const validDays = overviewDays.filter((d) => {
      const v = d.vormittag || { begin: '', ende: '', kommentar: '' };
      const n = d.nachmittag || { begin: '', ende: '', kommentar: '' };
      return (
        (v.begin && v.ende) ||
        (n.begin && n.ende) ||
        (d.workSumMinutes !== undefined && d.workSumMinutes > 0) ||
        (d.reserve !== undefined &&
          d.reserve !== '' &&
          d.reserve !== '+00:00' &&
          d.reserve !== '00:00' &&
          d.reserve !== '-00:00')
      );
    });

    // 2. Sort DESCENDING by date (newest first)
    const sortedDesc = [...validDays].sort((a, b) => (b.id || '').localeCompare(a.id || ''));

    return sortedDesc.map((d) => {
      const dKey = d.id || '';
      const workMins = d.workSumMinutes || 0;
      const targetMins =
        d.targetMinutes !== undefined ? d.targetMinutes : getTargetMinutesForDate(dKey);
      const saldoMins =
        d.daySaldoMinutes !== undefined ? d.daySaldoMinutes : workMins - targetMins;

      // Manual reserve for this day (default 0)
      const manualMins = parseTimeToMinutes(d.reserve) || 0;
      const dayZeitguthabenMins = manualMins + saldoMins;

      return {
        ...d,
        calculatedWorkMins: workMins,
        calculatedTargetMins: targetMins,
        calculatedSaldoMins: saldoMins,
        manualReserveMins: manualMins,
        manualReserveStr: formatMinutes(manualMins, true),
        dayZeitguthabenMins: dayZeitguthabenMins,
        dayZeitguthabenStr: formatMinutes(dayZeitguthabenMins, true),
      };
    });
  }, [overviewDays]);

  // Gesamte Überstunden = SUM of all days' Zeitguthaben (Saldo + Manual Reserve of each day)
  const currentTotalOvertimeMins = useMemo(() => {
    return processedOverviewDays.reduce((acc, d) => acc + d.dayZeitguthabenMins, 0);
  }, [processedOverviewDays]);

  const currentTotalOvertimeFormatted = formatMinutes(currentTotalOvertimeMins, true);

  // Total work hours across all days
  const totalWorkAllDaysMins = useMemo(() => {
    return processedOverviewDays.reduce((acc, d) => acc + d.calculatedWorkMins, 0);
  }, [processedOverviewDays]);

  // Load selected day on Daily tab
  const loadDayData = useCallback(
    async (dateArg: Date) => {
      if (!user) return;
      setSyncStatus('Lade…');
      isInitialLoad.current = true;
      const k = dateKey(dateArg);

      try {
        const snap = await db.collection('users').doc(user.uid).collection('days').doc(k).get();
        if (snap.exists) {
          const d = snap.data() || {};
          const v = d.vormittag || {};
          const n = d.nachmittag || {};
          setVBegin(v.begin || '');
          setVEnde(v.ende || '');
          setVKommentar(v.kommentar || '');
          setNBegin(n.begin || '');
          setNEnde(n.ende || '');
          setNKommentar(n.kommentar || '');
          setReserve(d.reserve || '+00:00');
        } else {
          setVBegin('');
          setVEnde('');
          setVKommentar('');
          setNBegin('');
          setNEnde('');
          setNKommentar('');
          setReserve('+00:00');
        }
        setSyncStatus('Synchronisiert');
      } catch (err: any) {
        setSyncStatus('Fehler beim Laden: ' + err.message);
      } finally {
        setTimeout(() => {
          isInitialLoad.current = false;
        }, 150);
      }
    },
    [user]
  );

  useEffect(() => {
    if (user && activeTab === 'daily') {
      loadDayData(currentDateObj);
    }
  }, [user, currentDateObj, activeTab, loadDayData]);

  // Execute direct save to Firestore
  const executeDirectSave = async (k: string, payload: any) => {
    if (!user) return;
    try {
      await db.collection('users').doc(user.uid).collection('days').doc(k).set(payload, { merge: true });
      setSyncStatus('Synchronisiert');
    } catch (err: any) {
      setSyncStatus('Fehler beim Speichern: ' + err.message);
    }
  };

  // Save day data to Firestore with debounce
  const scheduleDailySave = (
    vb: string,
    ve: string,
    vk: string,
    nb: string,
    ne: string,
    nk: string,
    res: string
  ) => {
    if (!user || isInitialLoad.current) return;
    setSyncStatus('Speichere…');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    const k = dateKey(currentDateObj);
    const targetMins = getTargetMinutesForDate(k);

    const vStart = parseTimeToMinutes(vb);
    const vEnd = parseTimeToMinutes(ve);
    let vDiff = 0;
    if (vStart !== null && vEnd !== null) {
      vDiff = vEnd - vStart;
      if (vDiff < 0) vDiff += 24 * 60;
    }

    const nStart = parseTimeToMinutes(nb);
    const nEnd = parseTimeToMinutes(ne);
    let nDiff = 0;
    if (nStart !== null && nEnd !== null) {
      nDiff = nEnd - nStart;
      if (nDiff < 0) nDiff += 24 * 60;
    }

    const workSum = vDiff + nDiff;
    const daySaldo = workSum - targetMins;
    const manualBase = parseTimeToMinutes(res) || 0;
    const newReserve = formatMinutes(manualBase + daySaldo, true);

    const payload = {
      vormittag: { begin: vb.trim(), ende: ve.trim(), kommentar: vk.trim() },
      nachmittag: { begin: nb.trim(), ende: ne.trim(), kommentar: nk.trim() },
      reserve: res.trim() || '+00:00',
      calculatedNewReserve: newReserve,
      workSumMinutes: workSum,
      daySaldoMinutes: daySaldo,
      targetMinutes: targetMins,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    pendingSavePayload.current = { k, payload };

    saveTimerRef.current = setTimeout(async () => {
      await executeDirectSave(k, payload);
      pendingSavePayload.current = null;
    }, 400);
  };

  // Calculations for Daily Tab
  const vStartMins = parseTimeToMinutes(vBegin);
  const vEndMins = parseTimeToMinutes(vEnde);
  let vTotalMins = 0;
  if (vStartMins !== null && vEndMins !== null) {
    vTotalMins = vEndMins - vStartMins;
    if (vTotalMins < 0) vTotalMins += 24 * 60;
  }

  const nStartMins = parseTimeToMinutes(nBegin);
  const nEndMins = parseTimeToMinutes(nEnde);
  let nTotalMins = 0;
  if (nStartMins !== null && nEndMins !== null) {
    nTotalMins = nEndMins - nStartMins;
    if (nTotalMins < 0) nTotalMins += 24 * 60;
  }

  const dailyGrandTotalMins = vTotalMins + nTotalMins;
  const currentTargetMins = getTargetMinutesForDate(dateKey(currentDateObj));
  const dailyRemainingMins = currentTargetMins - dailyGrandTotalMins;
  const dailyDaySaldoMins = dailyGrandTotalMins - currentTargetMins;

  // Manual base reserve for this day (supports negative values!)
  const dailyBaseReserveMins = parseTimeToMinutes(reserve) || 0;
  const dailyNewTotalReserveMins = dailyBaseReserveMins + dailyDaySaldoMins;

  // Flush pending save before switching tabs
  const handleTabChange = async (tab: 'daily' | 'overview') => {
    if (saveTimerRef.current && pendingSavePayload.current) {
      clearTimeout(saveTimerRef.current);
      const { k, payload } = pendingSavePayload.current;
      await executeDirectSave(k, payload);
      pendingSavePayload.current = null;
    }
    setActiveTab(tab);
  };

  // Day navigation
  const handlePrevDay = () => {
    const d = new Date(currentDateObj);
    do {
      d.setDate(d.getDate() - 1);
    } while (d.getDay() === 0 || d.getDay() === 6);
    setCurrentDateObj(d);
  };

  const handleNextDay = () => {
    const d = new Date(currentDateObj);
    do {
      d.setDate(d.getDate() + 1);
    } while (d.getDay() === 0 || d.getDay() === 6);
    setCurrentDateObj(d);
  };

  const handleResetDay = async () => {
    if (!user) return;
    setVBegin('');
    setVEnde('');
    setVKommentar('');
    setNBegin('');
    setNEnde('');
    setNKommentar('');
    setReserve('+00:00');
    const k = dateKey(currentDateObj);
    await db
      .collection('users')
      .doc(user.uid)
      .collection('days')
      .doc(k)
      .delete();
    setSyncStatus('Zurückgesetzt');
  };

  // Calculations for Overview form
  const ovVStartMins = parseTimeToMinutes(ovVBegin);
  const ovVEndMins = parseTimeToMinutes(ovVEnde);
  let ovVTotalMins = 0;
  if (ovVStartMins !== null && ovVEndMins !== null) {
    ovVTotalMins = ovVEndMins - ovVStartMins;
    if (ovVTotalMins < 0) ovVTotalMins += 24 * 60;
  }

  const ovNStartMins = parseTimeToMinutes(ovNBegin);
  const ovNEndMins = parseTimeToMinutes(ovNEnde);
  let ovNTotalMins = 0;
  if (ovNStartMins !== null && ovNEndMins !== null) {
    ovNTotalMins = ovNEndMins - ovNStartMins;
    if (ovNTotalMins < 0) ovNTotalMins += 24 * 60;
  }

  const ovTotalWorkMins = ovVTotalMins + ovNTotalMins;
  const ovTargetMins = getTargetMinutesForDate(ovDate);
  const ovRemainingMins = ovTargetMins - ovTotalWorkMins;
  const ovSaldoMins = ovTotalWorkMins - ovTargetMins;

  // Manual base reserve for overview form (supports negative values!)
  const ovBaseReserveMins = parseTimeToMinutes(ovReserve) || 0;
  const ovNewTotalReserveMins = ovBaseReserveMins + ovSaldoMins;

  // Load a day into Overview form for editing
  const loadDayIntoOverviewForm = async (dKey: string) => {
    if (!user) return;
    setOvDate(dKey);
    setOvFormStatus('Lade Tag…');
    setShowAddForm(true);

    try {
      const snap = await db.collection('users').doc(user.uid).collection('days').doc(dKey).get();
      if (snap.exists) {
        const d = snap.data() || {};
        const v = d.vormittag || {};
        const n = d.nachmittag || {};
        setOvVBegin(v.begin || '');
        setOvVEnde(v.ende || '');
        setOvVKommentar(v.kommentar || '');
        setOvNBegin(n.begin || '');
        setOvNEnde(n.ende || '');
        setOvNKommentar(n.kommentar || '');
        setOvReserve(d.reserve || '+00:00');
        setOvFormStatus('Daten geladen');
      } else {
        setOvVBegin('');
        setOvVEnde('');
        setOvVKommentar('');
        setOvNBegin('');
        setOvNEnde('');
        setOvNKommentar('');
        setOvReserve('+00:00');
        setOvFormStatus('Neuer Eintrag');
      }
    } catch (err: any) {
      setOvFormStatus('Fehler: ' + err.message);
    }
  };

  // Submit Overview form
  const handleSaveOverviewDay = async () => {
    if (!user || !ovDate) return;
    setOvSubmitting(true);
    setOvFormStatus('Speichere & Synchronisiere…');

    try {
      const dayRef = db.collection('users').doc(user.uid).collection('days').doc(ovDate);
      const calculatedNewReserve = formatMinutes(ovNewTotalReserveMins, true);

      await dayRef.set(
        {
          vormittag: {
            begin: ovVBegin.trim(),
            ende: ovVEnde.trim(),
            kommentar: ovVKommentar.trim(),
          },
          nachmittag: {
            begin: ovNBegin.trim(),
            ende: ovNEnde.trim(),
            kommentar: ovNKommentar.trim(),
          },
          workSumMinutes: ovTotalWorkMins,
          targetMinutes: ovTargetMins,
          daySaldoMinutes: ovSaldoMins,
          reserve: ovReserve.trim() || '+00:00',
          calculatedNewReserve: calculatedNewReserve,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      setOvFormStatus('Gespeichert & Synchronisiert!');
      if (dateKey(currentDateObj) === ovDate) {
        loadDayData(currentDateObj);
      }
      setTimeout(() => {
        setShowAddForm(false);
      }, 700);
    } catch (err: any) {
      setOvFormStatus('Fehler: ' + err.message);
    } finally {
      setOvSubmitting(false);
    }
  };

  // Confirm delete day function
  const confirmDeleteDay = async () => {
    if (!user || !dayToDelete) return;
    const targetKey = dayToDelete;
    setDayToDelete(null);

    try {
      await db.collection('users').doc(user.uid).collection('days').doc(targetKey).delete();
      if (dateKey(currentDateObj) === targetKey) {
        handleResetDay();
      }
      if (ovDate === targetKey && showAddForm) {
        setShowAddForm(false);
      }
    } catch (err: any) {
      console.error('Fehler beim Löschen:', err);
    }
  };

  // Switch to Day in Daily tab
  const handleSwitchToDay = (dKey: string) => {
    const parts = dKey.split('-').map(Number);
    setCurrentDateObj(new Date(parts[0], parts[1] - 1, parts[2]));
    handleTabChange('daily');
  };

  // Auth Submit
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    if (!loginName || !loginPassword) {
      setAuthError('Bitte Name und Passwort eingeben.');
      return;
    }
    if (loginPassword.length < 6) {
      setAuthError('Passwort muss mind. 6 Zeichen haben.');
      return;
    }

    const email = nameToEmail(loginName);
    setAuthLoading(true);
    try {
      if (authMode === 'login') {
        await auth.signInWithEmailAndPassword(email, loginPassword);
      } else {
        const cred = await auth.createUserWithEmailAndPassword(email, loginPassword);
        if (cred.user) {
          await cred.user.updateProfile({ displayName: loginName });
          await db
            .collection('users')
            .doc(cred.user.uid)
            .set({ displayName: loginName }, { merge: true });
        }
      }
    } catch (err: any) {
      switch (err.code) {
        case 'auth/user-not-found':
          setAuthError('Kein Konto mit diesem Namen gefunden.');
          break;
        case 'auth/wrong-password':
          setAuthError('Falsches Passwort.');
          break;
        case 'auth/email-already-in-use':
          setAuthError('Dieser Name ist bereits vergeben.');
          break;
        case 'auth/invalid-email':
          setAuthError('Ungültiger Name.');
          break;
        case 'auth/weak-password':
          setAuthError('Passwort ist zu schwach (mind. 6 Zeichen).');
          break;
        default:
          setAuthError('Fehler: ' + err.message);
      }
    } finally {
      setAuthLoading(false);
    }
  };

  // ============ LOGIN SCREEN ============
  if (!user) {
    return (
      <div className="login-wrap" id="login-screen">
        <div className="login-card">
          <h1 id="login-title">{authMode === 'login' ? 'Anmelden' : 'Konto erstellen'}</h1>
          {authError && (
            <div className="login-error" id="login-error">
              {authError}
            </div>
          )}

          <form onSubmit={handleAuthSubmit}>
            <div className="field">
              <label>Name</label>
              <input
                type="text"
                id="login-name"
                placeholder="z. B. Nazar oder Cillian"
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="field">
              <label>Passwort</label>
              <input
                type="password"
                id="login-password"
                placeholder="••••••••"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            <button type="submit" className="btn-primary" id="login-submit" disabled={authLoading}>
              {authLoading ? 'Bitte warten…' : authMode === 'login' ? 'Anmelden' : 'Registrieren'}
            </button>
          </form>

          <div className="login-switch">
            <span id="switch-text">
              {authMode === 'login' ? 'Noch kein Konto?' : 'Bereits ein Konto?'}
            </span>{' '}
            <a
              id="switch-link"
              onClick={() => {
                setAuthError('');
                setAuthMode(authMode === 'login' ? 'register' : 'login');
              }}
            >
              {authMode === 'login' ? 'Konto erstellen' : 'Anmelden'}
            </a>
          </div>
        </div>
      </div>
    );
  }

  // ============ MAIN APP ============
  return (
    <div className="container" id="app-screen">
      {/* Topbar with user info and tabs */}
      <div className="topbar">
        <div className="tabs-bar" style={{ marginBottom: 0, borderBottom: 'none' }}>
          <button
            className={`tab-btn ${activeTab === 'daily' ? 'active' : ''}`}
            id="tab-btn-daily"
            onClick={() => handleTabChange('daily')}
          >
            Tageserfassung
          </button>
          <button
            className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
            id="tab-btn-overview"
            onClick={() => handleTabChange('overview')}
          >
            Überstunden-Übersicht
          </button>
        </div>
        <div className="user-badge">
          <span id="user-name-label">{user.displayName || user.email?.split('@')[0]}</span>
          <button className="btn-logout" id="logout-btn" onClick={() => auth.signOut()}>
            Abmelden
          </button>
        </div>
      </div>

      {/* TAB 1: DAILY TRACKER */}
      {activeTab === 'daily' && (
        <div id="tab-content-daily">
          <div className="topbar" style={{ marginBottom: 16 }}>
            <div className="day-nav">
              <button className="btn-nav" id="prev-day" title="Vorheriger Arbeitstag" onClick={handlePrevDay}>
                ‹
              </button>
              <div className="date-header" id="current-date">
                {currentDateObj.toLocaleDateString('de-DE', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </div>
              <button className="btn-nav" id="next-day" title="Nächster Arbeitstag" onClick={handleNextDay}>
                ›
              </button>
            </div>
          </div>

          <div className="card">
            <h1 className="card-title">Arbeitszeiten erfassen</h1>

            <div className="grid-header">
              <div>Beginn</div>
              <div>Ende</div>
              <div>Total</div>
              <div>Kommentar</div>
            </div>

            <div className="time-rows" id="rows-container">
              {/* VOR Row */}
              <div className="time-row" data-slot="vormittag">
                <div className="row-tag">VOR</div>
                <div className="input-group">
                  <label>Beginn *</label>
                  <input
                    type="text"
                    className="time-field input-begin"
                    placeholder="HH:MM"
                    maxLength={5}
                    value={vBegin}
                    onChange={(e) => {
                      const val = formatTimeInput(e.target.value);
                      setVBegin(val);
                      scheduleDailySave(val, vEnde, vKommentar, nBegin, nEnde, nKommentar, reserve);
                    }}
                  />
                </div>
                <div className="input-group">
                  <label>Ende *</label>
                  <input
                    type="text"
                    className="time-field input-ende"
                    placeholder="HH:MM"
                    maxLength={5}
                    value={vEnde}
                    onChange={(e) => {
                      const val = formatTimeInput(e.target.value);
                      setVEnde(val);
                      scheduleDailySave(vBegin, val, vKommentar, nBegin, nEnde, nKommentar, reserve);
                    }}
                  />
                </div>
                <div className="total-time">{formatMinutes(vTotalMins)}</div>
                <div className="input-group">
                  <label>Kommentar</label>
                  <input
                    type="text"
                    className="kommentar-field input-kommentar"
                    placeholder="Optionale Notiz"
                    value={vKommentar}
                    onChange={(e) => {
                      setVKommentar(e.target.value);
                      scheduleDailySave(vBegin, vEnde, e.target.value, nBegin, nEnde, nKommentar, reserve);
                    }}
                  />
                </div>
              </div>

              {/* NACH Row */}
              <div className="time-row" data-slot="nachmittag">
                <div className="row-tag">NACH</div>
                <div className="input-group">
                  <label>Beginn *</label>
                  <input
                    type="text"
                    className="time-field input-begin"
                    placeholder="HH:MM"
                    maxLength={5}
                    value={nBegin}
                    onChange={(e) => {
                      const val = formatTimeInput(e.target.value);
                      setNBegin(val);
                      scheduleDailySave(vBegin, vEnde, vKommentar, val, nEnde, nKommentar, reserve);
                    }}
                  />
                </div>
                <div className="input-group">
                  <label>Ende *</label>
                  <input
                    type="text"
                    className="time-field input-ende"
                    placeholder="HH:MM"
                    maxLength={5}
                    value={nEnde}
                    onChange={(e) => {
                      const val = formatTimeInput(e.target.value);
                      setNEnde(val);
                      scheduleDailySave(vBegin, vEnde, vKommentar, nBegin, val, nKommentar, reserve);
                    }}
                  />
                </div>
                <div className="total-time">{formatMinutes(nTotalMins)}</div>
                <div className="input-group">
                  <label>Kommentar</label>
                  <input
                    type="text"
                    className="kommentar-field input-kommentar"
                    placeholder="Optionale Notiz"
                    value={nKommentar}
                    onChange={(e) => {
                      setNKommentar(e.target.value);
                      scheduleDailySave(vBegin, vEnde, vKommentar, nBegin, nEnde, e.target.value, reserve);
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="actions">
              <div className="btn-group">
                <button className="btn-reset" id="reset-btn" onClick={handleResetDay}>
                  Tag zurücksetzen
                </button>
              </div>
              <div className="grand-total">
                Gesamtsumme: <span id="grand-total-val">{formatMinutes(dailyGrandTotalMins)}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <h2 style={{ fontSize: '1.2rem', marginTop: 0, marginBottom: 16 }} id="sollzeit-title">
              {currentTargetMins === 0
                ? 'Sollzeit-Berechnung (Wochenende)'
                : 'Sollzeit-Berechnung (08:12)'}
            </h2>
            <div className="target-card">
              <div className="stat-box">
                <label className="stat-label">Bestehendes Zeitguthaben ( +/- )</label>
                <div className="reserve-input-wrap">
                  <button
                    type="button"
                    className="btn-toggle-sign"
                    id="daily-toggle-sign-btn"
                    title="Vorzeichen wechseln (+ / -)"
                    onClick={() => {
                      const toggled = toggleReserveSign(reserve);
                      setReserve(toggled);
                      scheduleDailySave(vBegin, vEnde, vKommentar, nBegin, nEnde, nKommentar, toggled);
                    }}
                  >
                    {reserve.startsWith('-') ? '− Minus' : '+ Plus'}
                  </button>
                  <input
                    type="text"
                    id="reserve-input"
                    placeholder="+00:00 / -00:00"
                    maxLength={7}
                    value={reserve}
                    onChange={(e) => {
                      const val = formatReserveInput(e.target.value);
                      setReserve(val);
                      scheduleDailySave(vBegin, vEnde, vKommentar, nBegin, nEnde, nKommentar, val);
                    }}
                  />
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Restzeit bis Soll</div>
                <div
                  className={`stat-value ${
                    currentTargetMins === 0 || dailyRemainingMins <= 0 ? 'pos' : 'neg'
                  }`}
                  id="remaining-time"
                >
                  {currentTargetMins === 0
                    ? dailyGrandTotalMins > 0
                      ? `+${formatMinutes(dailyGrandTotalMins)} (Überzeit)`
                      : '00:00'
                    : dailyRemainingMins > 0
                    ? formatMinutes(dailyRemainingMins)
                    : dailyRemainingMins === 0
                    ? '00:00 (Soll erreicht)'
                    : `+${formatMinutes(Math.abs(dailyRemainingMins))} (Überzeit)`}
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Tages-Saldo</div>
                <div
                  className={`stat-value ${
                    dailyDaySaldoMins > 0 ? 'pos' : dailyDaySaldoMins < 0 ? 'neg' : 'neutral'
                  }`}
                  id="day-saldo"
                >
                  {formatMinutes(dailyDaySaldoMins, true)}
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Neues Zeitguthaben</div>
                <div
                  className={`stat-value ${
                    dailyNewTotalReserveMins > 0
                      ? 'pos'
                      : dailyNewTotalReserveMins < 0
                      ? 'neg'
                      : 'neutral'
                  }`}
                  id="total-reserve"
                >
                  {formatMinutes(dailyNewTotalReserveMins, true)}
                </div>
              </div>
            </div>
          </div>

          <div className="sync-note" id="sync-note">
            {syncStatus}
          </div>
        </div>
      )}

      {/* TAB 2: OVERVIEW ALL DAYS */}
      {activeTab === 'overview' && (
        <div id="tab-content-overview">
          <div className="card">
            <h1 className="card-title">Überstunden-Übersicht</h1>

            <div className="target-card" style={{ marginBottom: 24 }}>
              <div className="stat-box">
                <div className="stat-label">Gesamte Überstunden (Summe aller Tage)</div>
                <div
                  className={`stat-value ${
                    currentTotalOvertimeMins > 0
                      ? 'pos'
                      : currentTotalOvertimeMins < 0
                      ? 'neg'
                      : 'neutral'
                  }`}
                  id="overview-total-overtime"
                >
                  {currentTotalOvertimeFormatted}
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Gesamte Arbeitszeit (Summe)</div>
                <div className="stat-value neutral" id="overview-total-worktime">
                  {formatMinutes(totalWorkAllDaysMins)}
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Erfasste Tage</div>
                <div className="stat-value neutral" id="overview-total-days">
                  {processedOverviewDays.length}
                </div>
              </div>
            </div>

            <div className="overview-header">
              <h3 style={{ fontSize: '1.1rem', margin: 0, color: 'var(--text-muted)' }}>
                Verlauf nach Tagen
              </h3>
              <button
                className="btn-add-day"
                id="toggle-add-day-btn"
                onClick={() => {
                  if (showAddForm) {
                    setShowAddForm(false);
                  } else {
                    loadDayIntoOverviewForm(ovDate || dateKey(new Date()));
                  }
                }}
              >
                + Zeit erfassen / Tag hinzufügen
              </button>
            </div>

            {/* FULL DAY FORM ON OVERVIEW */}
            {showAddForm && (
              <div className="add-day-box" id="add-day-form">
                <div className="add-day-box-header">
                  <h4 className="add-day-box-title" id="overview-form-title">
                    Arbeitszeit für Tag erfassen ({ovDate ? ovDate.split('-').reverse().join('.') : ''})
                  </h4>
                  <span className="sync-note" id="overview-form-status" style={{ margin: 0 }}>
                    {ovFormStatus}
                  </span>
                </div>

                <div className="date-row-container">
                  <label htmlFor="new-date-input">Datum auswählen:</label>
                  <input
                    type="date"
                    id="new-date-input"
                    value={ovDate}
                    onChange={(e) => {
                      if (e.target.value) {
                        loadDayIntoOverviewForm(e.target.value);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="quick-date-btn"
                    id="btn-set-today"
                    onClick={() => loadDayIntoOverviewForm(dateKey(new Date()))}
                  >
                    Heute
                  </button>
                  <button
                    type="button"
                    className="quick-date-btn"
                    id="btn-set-yesterday"
                    onClick={() => {
                      const y = new Date();
                      y.setDate(y.getDate() - 1);
                      loadDayIntoOverviewForm(dateKey(y));
                    }}
                  >
                    Gestern
                  </button>
                </div>

                <div className="grid-header">
                  <div>Beginn</div>
                  <div>Ende</div>
                  <div>Total</div>
                  <div>Kommentar</div>
                </div>

                <div className="time-rows" id="overview-rows-container">
                  {/* Overview VOR Row */}
                  <div className="time-row" data-slot="vormittag">
                    <div className="row-tag">VOR</div>
                    <div className="input-group">
                      <label>Beginn *</label>
                      <input
                        type="text"
                        className="time-field input-begin"
                        placeholder="HH:MM"
                        maxLength={5}
                        value={ovVBegin}
                        onChange={(e) => setOvVBegin(formatTimeInput(e.target.value))}
                      />
                    </div>
                    <div className="input-group">
                      <label>Ende *</label>
                      <input
                        type="text"
                        className="time-field input-ende"
                        placeholder="HH:MM"
                        maxLength={5}
                        value={ovVEnde}
                        onChange={(e) => setOvVEnde(formatTimeInput(e.target.value))}
                      />
                    </div>
                    <div className="total-time">{formatMinutes(ovVTotalMins)}</div>
                    <div className="input-group">
                      <label>Kommentar</label>
                      <input
                        type="text"
                        className="kommentar-field input-kommentar"
                        placeholder="Optionale Notiz"
                        value={ovVKommentar}
                        onChange={(e) => setOvVKommentar(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Overview NACH Row */}
                  <div className="time-row" data-slot="nachmittag">
                    <div className="row-tag">NACH</div>
                    <div className="input-group">
                      <label>Beginn *</label>
                      <input
                        type="text"
                        className="time-field input-begin"
                        placeholder="HH:MM"
                        maxLength={5}
                        value={ovNBegin}
                        onChange={(e) => setOvNBegin(formatTimeInput(e.target.value))}
                      />
                    </div>
                    <div className="input-group">
                      <label>Ende *</label>
                      <input
                        type="text"
                        className="time-field input-ende"
                        placeholder="HH:MM"
                        maxLength={5}
                        value={ovNEnde}
                        onChange={(e) => setOvNEnde(formatTimeInput(e.target.value))}
                      />
                    </div>
                    <div className="total-time">{formatMinutes(ovNTotalMins)}</div>
                    <div className="input-group">
                      <label>Kommentar</label>
                      <input
                        type="text"
                        className="kommentar-field input-kommentar"
                        placeholder="Optionale Notiz"
                        value={ovNKommentar}
                        onChange={(e) => setOvNKommentar(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {/* Sollzeit & Zeitguthaben Berechnung in Overview Edit Tab */}
                <div style={{ marginTop: 20 }}>
                  <h4 style={{ fontSize: '1.05rem', fontWeight: 600, marginTop: 0, marginBottom: 12 }}>
                    {ovTargetMins === 0
                      ? 'Sollzeit-Berechnung (Wochenende)'
                      : 'Sollzeit-Berechnung (08:12)'}
                  </h4>
                  <div className="target-card">
                    <div className="stat-box">
                      <label className="stat-label">Bestehendes Zeitguthaben ( +/- )</label>
                      <div className="reserve-input-wrap">
                        <button
                          type="button"
                          className="btn-toggle-sign"
                          id="ov-toggle-sign-btn"
                          title="Vorzeichen wechseln (+ / -)"
                          onClick={() => {
                            setOvReserve((prev) => toggleReserveSign(prev));
                          }}
                        >
                          {ovReserve.startsWith('-') ? '− Minus' : '+ Plus'}
                        </button>
                        <input
                          type="text"
                          id="ov-reserve-input"
                          placeholder="+00:00 / -00:00"
                          maxLength={7}
                          value={ovReserve}
                          onChange={(e) => setOvReserve(formatReserveInput(e.target.value))}
                        />
                      </div>
                    </div>
                    <div className="stat-box">
                      <div className="stat-label">Restzeit bis Soll</div>
                      <div
                        className={`stat-value ${
                          ovTargetMins === 0 || ovRemainingMins <= 0 ? 'pos' : 'neg'
                        }`}
                      >
                        {ovTargetMins === 0
                          ? ovTotalWorkMins > 0
                            ? `+${formatMinutes(ovTotalWorkMins)} (Überzeit)`
                            : '00:00'
                          : ovRemainingMins > 0
                          ? formatMinutes(ovRemainingMins)
                          : ovRemainingMins === 0
                          ? '00:00 (Soll erreicht)'
                          : `+${formatMinutes(Math.abs(ovRemainingMins))} (Überzeit)`}
                      </div>
                    </div>
                    <div className="stat-box">
                      <div className="stat-label">Tages-Saldo</div>
                      <div
                        className={`stat-value ${
                          ovSaldoMins > 0 ? 'pos' : ovSaldoMins < 0 ? 'neg' : 'neutral'
                        }`}
                      >
                        {formatMinutes(ovSaldoMins, true)}
                      </div>
                    </div>
                    <div className="stat-box">
                      <div className="stat-label">Neues Zeitguthaben</div>
                      <div
                        className={`stat-value ${
                          ovNewTotalReserveMins > 0
                            ? 'pos'
                            : ovNewTotalReserveMins < 0
                            ? 'neg'
                            : 'neutral'
                        }`}
                      >
                        {formatMinutes(ovNewTotalReserveMins, true)}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="actions" style={{ marginTop: 20, paddingTop: 14 }}>
                  <div className="btn-group">
                    <button
                      type="button"
                      className="btn-add-day"
                      id="submit-add-day-btn"
                      disabled={ovSubmitting}
                      onClick={handleSaveOverviewDay}
                    >
                      💾 Speichern &amp; Synchronisieren
                    </button>
                    <button
                      type="button"
                      className="btn-cancel-box"
                      id="cancel-add-day-btn"
                      onClick={() => setShowAddForm(false)}
                    >
                      Schließen
                    </button>
                    <button
                      type="button"
                      className="btn-action-icon btn-delete"
                      style={{ padding: '6px 12px', borderRadius: 8, fontSize: '0.85rem' }}
                      title="Diesen Eintrag löschen"
                      onClick={() => setDayToDelete(ovDate)}
                    >
                      🗑️ Tag löschen
                    </button>
                  </div>
                  <div className="grand-total" style={{ fontSize: '0.95rem' }}>
                    Gesamt: <span>{formatMinutes(ovTotalWorkMins)}</span> | Saldo:{' '}
                    <span
                      style={{
                        color:
                          ovSaldoMins > 0
                            ? 'var(--success)'
                            : ovSaldoMins < 0
                            ? 'var(--danger)'
                            : 'var(--text-main)',
                      }}
                    >
                      {formatMinutes(ovSaldoMins, true)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div style={{ overflowX: 'auto' }}>
              <table className="overview-table">
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Vormittag</th>
                    <th>Nachmittag</th>
                    <th>Arbeitszeit</th>
                    <th>Sollzeit</th>
                    <th>Tages-Saldo</th>
                    <th>Zeitguthaben</th>
                    <th style={{ width: 80, textAlign: 'center' }}>Aktionen</th>
                  </tr>
                </thead>
                <tbody id="overview-table-body">
                  {overviewLoading ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                        Lade Daten…
                      </td>
                    </tr>
                  ) : processedOverviewDays.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                        Noch keine Tage erfasst. Klicke auf "+ Zeit erfassen / Tag hinzufügen", um zu
                        starten.
                      </td>
                    </tr>
                  ) : (
                    processedOverviewDays.map((d) => {
                      const dKey = d.id || '';
                      const v = d.vormittag || { begin: '', ende: '', kommentar: '' };
                      const n = d.nachmittag || { begin: '', ende: '', kommentar: '' };
                      const workMins = d.calculatedWorkMins;
                      const targetMins = d.calculatedTargetMins;
                      const saldoMins = d.calculatedSaldoMins;
                      const dayZeitguthabenMins = d.dayZeitguthabenMins;
                      const formattedZeitguthaben = d.dayZeitguthabenStr;

                      const formattedDate = dKey.split('-').reverse().join('.');
                      const vText = v.begin && v.ende ? `${v.begin} - ${v.ende}` : '—';
                      const nText = n.begin && n.ende ? `${n.begin} - ${n.ende}` : '—';
                      const kommentarText = [v.kommentar, n.kommentar].filter(Boolean).join(' | ');

                      return (
                        <tr key={dKey}>
                          <td>
                            <strong>{formattedDate}</strong>
                            {kommentarText && (
                              <div className="comment-preview" title={kommentarText}>
                                💬 {kommentarText}
                              </div>
                            )}
                          </td>
                          <td>
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{vText}</span>
                          </td>
                          <td>
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{nText}</span>
                          </td>
                          <td>
                            <strong>{formatMinutes(workMins)}</strong>
                          </td>
                          <td style={{ color: 'var(--text-muted)' }}>{formatMinutes(targetMins)}</td>
                          <td
                            style={{
                              color:
                                saldoMins > 0
                                  ? 'var(--success)'
                                  : saldoMins < 0
                                  ? 'var(--danger)'
                                  : 'inherit',
                              fontWeight: saldoMins !== 0 ? 700 : 500,
                            }}
                          >
                            {formatMinutes(saldoMins, true)}
                          </td>
                          <td
                            style={{
                              color:
                                dayZeitguthabenMins > 0
                                  ? 'var(--success)'
                                  : dayZeitguthabenMins < 0
                                  ? 'var(--danger)'
                                  : 'inherit',
                              fontWeight: 700,
                            }}
                          >
                            {formattedZeitguthaben}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <div className="row-actions">
                              <button
                                className="btn-action-icon btn-edit"
                                title="Auf dieser Seite bearbeiten"
                                onClick={() => loadDayIntoOverviewForm(dKey)}
                              >
                                ✏️
                              </button>
                              <button
                                className="btn-action-icon btn-open-day"
                                title="In Tagesansicht öffnen"
                                onClick={() => handleSwitchToDay(dKey)}
                              >
                                📅
                              </button>
                              <button
                                className="btn-action-icon btn-delete"
                                title="Löschen"
                                onClick={() => setDayToDelete(dKey)}
                              >
                                🗑️
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* CUSTOM IN-APP CONFIRMATION MODAL */}
      {dayToDelete && (
        <div className="modal-overlay" onClick={() => setDayToDelete(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Eintrag löschen</h3>
            <p className="modal-desc">
              Möchtest du den Eintrag vom{' '}
              <strong>{dayToDelete.split('-').reverse().join('.')}</strong> wirklich unwiderruflich
              löschen?
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-cancel-box"
                onClick={() => setDayToDelete(null)}
              >
                Abbrechen
              </button>
              <button
                type="button"
                className="btn-danger-solid"
                onClick={confirmDeleteDay}
              >
                🗑️ Ja, Eintrag löschen
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="footer-credit">
        Made by Nazar &amp; Cillian (with using Gemini &amp; Claude)
      </div>
    </div>
  );
}
