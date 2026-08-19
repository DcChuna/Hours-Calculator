import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyB12ed9Sq9SiGA3nxQxz6bdsz1Tul4J2mM",
  authDomain: "zeit-rechner.firebaseapp.com",
  projectId: "zeit-rechner",
  storageBucket: "zeit-rechner.firebasestorage.app",
  messagingSenderId: "659923235857",
  appId: "1:659923235857:web:6c563ca356fc626ab1adb0",
  measurementId: "G-TYKBP8622H"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

export const auth = firebase.auth();
export const db = firebase.firestore();
export default firebase;
