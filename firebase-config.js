// ─── Firebase Configuration ───────────────────────────────────────────────────
// To enable Google sign-in and cloud sync across devices:
//
// 1. Go to https://console.firebase.google.com
// 2. Create a new project (or use an existing one)
// 3. In the project: click "Add app" → Web (</>)
// 4. Register the app and copy the firebaseConfig object values below
// 5. In Firebase console → Authentication → Sign-in method → Enable "Google"
// 6. In Firebase console → Firestore Database → Create database
//    (start in "test mode" for development, then add security rules for production)
//
// Recommended Firestore Security Rules (Firestore → Rules tab):
//
//   rules_version = '2';
//   service cloud.firestore {
//     match /databases/{database}/documents {
//       match /users/{userId}/{document=**} {
//         allow read, write: if request.auth != null && request.auth.uid == userId;
//       }
//     }
//   }
//
// Leave all fields as empty strings "" to run the app in local-only mode (no auth).

window.FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
