package main

type accountConfig struct {
	Username         string   `json:"username"`
	DisplayName      string   `json:"displayName"`
	Role             string   `json:"role"`
	Salt             string   `json:"salt"`
	PasswordVerifier string   `json:"passwordVerifier"`
	Iterations       int      `json:"iterations"`
	PatientIDs       []string `json:"patientIds"`

	salt          []byte
	verifier      []byte
	patientScopes map[string]bool
}

func isKnownPatient(patientID string) bool {
	_, ok := patients[patientID]
	return ok
}
