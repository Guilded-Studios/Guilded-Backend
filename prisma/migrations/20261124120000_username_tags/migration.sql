ALTER TABLE "User" ADD COLUMN "tag" TEXT;
UPDATE "User"
SET "tag" = lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
ALTER TABLE "User" ALTER COLUMN "tag" SET NOT NULL;
DROP INDEX IF EXISTS "User_username_key";
CREATE UNIQUE INDEX "User_username_tag_key" ON "User"("username", "tag");
CREATE INDEX "User_username_idx" ON "User"("username");
