import unittest

from scripts.guard_stale_full_snapshot import validate_not_stale, verified_finals


def game(event_id, home="Clube A", away="Clube B", score=(2, 1)):
    return {"event_id": event_id, "mandante": {"nome": home},
            "visitante": {"nome": away}, "estado": "post",
            "placar_mandante": score[0], "placar_visitante": score[1]}


class PostfinalMonotonicTest(unittest.TestCase):
    def test_full_rebuild_never_drops_fastlane_final(self):
        latest = {"resultados": [game("401841313"), game("401841314")]}
        previous = {"resultados": [game("401841313")]}
        with self.assertRaisesRegex(ValueError, "obsoleta"):
            validate_not_stale(previous, latest)

    def test_full_rebuild_cannot_change_existing_final_score(self):
        latest = {"resultados": [game("401841313", score=(2, 1))]}
        stale = {"resultados": [game("401841313", score=(1, 1))]}
        with self.assertRaisesRegex(ValueError, "divergentes"):
            validate_not_stale(stale, latest)

    def test_full_rebuild_with_all_previous_finals_passes(self):
        latest = {"resultados": [game("401841313")]}
        candidate = {"resultados": [game("401841313"), game("401841314")]}
        validate_not_stale(candidate, latest)

    def test_duplicate_conflicting_finals_rejected(self):
        with self.assertRaisesRegex(ValueError, "contraditório"):
            verified_finals({"resultados": [game("401841313"),game("401841313",score=(1,1))]})

    def test_in_play_does_not_become_final(self):
        current = {"resultados": [game("401841313")]}
        pending = {**game("401841315"), "estado":"in"}
        candidate = {"resultados": [game("401841313"),pending]}
        validate_not_stale(candidate,current)
        self.assertEqual(len(verified_finals(candidate)),1)


if __name__ == "__main__":
    unittest.main()
