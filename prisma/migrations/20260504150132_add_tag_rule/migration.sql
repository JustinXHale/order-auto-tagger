-- CreateTable
CREATE TABLE "TagRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT,
    "tags" TEXT NOT NULL,
    "productIds" TEXT NOT NULL,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "TagRule_shop_idx" ON "TagRule"("shop");
