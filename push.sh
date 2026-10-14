git checkout --orphan latest
git add -A
git commit -m "latest snapshot"

git branch -M main
git push -f origin main
