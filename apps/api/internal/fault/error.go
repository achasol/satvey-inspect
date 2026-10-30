package fault

// Error is an expected, public HTTP error. Internal errors are never returned verbatim.
type Error struct {
	Status  int
	Message string
}

func (e Error) Error() string              { return e.Message }
func New(status int, message string) error { return Error{status, message} }
