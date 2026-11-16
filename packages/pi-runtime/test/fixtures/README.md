# Hermes compatibility fixtures

`pi-community-profile-v1.ts.txt` freezes the profile reader before structured-facts support (original development revision `3212ade8`). The revision identifies its provenance only: tests must never retrieve it from Git at runtime. The snapshot deliberately keeps the original fingerprint serialization, so adding a field such as `factPolicy:null` still breaks the compatibility regression.

`legacy-community-profile.ts` builds this snapshot with the runtime's existing local helper imports. Both the fingerprint regression and real Pi history-resume tests use it. Keep the snapshot unchanged when updating the production reader; a new legacy protocol needs a new fixture.
